import { randomUUID } from "crypto";
import { buildFinalDraftMarkdown, buildFinalDraftMarkdownForItems, normalizeBenchmarkVideos, publishWarehouseCells } from "./exportFormatters.js";
import { AgentError, fetchJson, retryDelayMs, sleep } from "./contentAgent/http.js";

const FEISHU_BASE_URL = "https://open.feishu.cn";
const DEFAULT_DOC_BASE_URL = "https://feishu.cn";
const MAX_BLOCKS_PER_REQUEST = 40;
const MAX_TEXT_LENGTH = 1800;

const getEnv = (key) => String(process.env?.[key] || "").trim();

export const getFeishuConfig = () => ({
  appId: getEnv("FEISHU_APP_ID"),
  appSecret: getEnv("FEISHU_APP_SECRET"),
  folderToken: getEnv("FEISHU_FOLDER_TOKEN"),
  bitableAppToken: getEnv("FEISHU_BITABLE_APP_TOKEN"),
  bitableTableId: getEnv("FEISHU_BITABLE_TABLE_ID"),
  baseUrl: getEnv("FEISHU_BASE_URL") || FEISHU_BASE_URL,
  docBaseUrl: (getEnv("FEISHU_DOC_BASE_URL") || DEFAULT_DOC_BASE_URL).replace(/\/+$/, ""),
  retryAttempts: Number.parseInt(getEnv("AGENT_API_RETRY_ATTEMPTS") || "2", 10),
  retryBaseDelayMs: Number.parseInt(getEnv("AGENT_API_RETRY_BASE_DELAY_MS") || "500", 10),
});

const ensureFeishuConfigured = (config) => {
  if (!config.appId || !config.appSecret) {
    throw new AgentError("Missing FEISHU_APP_ID or FEISHU_APP_SECRET", {
      code: "FEISHU_CONFIG_MISSING",
      status: 500,
    });
  }
};

const isRetryableFeishuCode = (code) => {
  const value = Number(code);
  return (
    value === 99991400 ||
    value === 1254290 ||
    value === 1254291 ||
    value === 1254607 ||
    value === 1255001 ||
    value === 1255002 ||
    value === 1255005 ||
    value === 1255040
  );
};

const feishuRequest = async (path, body, config, options = {}) => {
  const logger = options.logger;
  const url = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const maxAttempts = Math.max(1, Number(config.retryAttempts || 0) + 1);
  const method = options.method || "POST";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { data, response } = await fetchJson(url, {
      method,
      timeoutMs: options.timeoutMs || 60000,
      retries: config.retryAttempts,
      retryBaseDelayMs: config.retryBaseDelayMs,
      logger,
      interfaceName: options.interfaceName || "feishu:api",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...(options.tenantAccessToken ? { Authorization: `Bearer ${options.tenantAccessToken}` } : {}),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body || {}) }),
      logFields: {
        feishuAttempt: attempt,
        feishuMaxAttempts: maxAttempts,
      },
    });

    if (data?.code === 0) {
      return data;
    }

    if (attempt < maxAttempts && isRetryableFeishuCode(data?.code)) {
      const delayMs = retryDelayMs(attempt, config.retryBaseDelayMs);
      logger?.warn("external.request.retry", {
        interface: options.interfaceName || "feishu:api",
        method,
        endpoint: url,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: `Feishu code ${data?.code}`,
        status: response.status,
      });
      await sleep(delayMs);
      continue;
    }

    throw new AgentError(data?.msg || `Feishu API failed with code ${data?.code}`, {
      code: "FEISHU_API_FAILED",
      status: response.status || 500,
      details: {
        feishuCode: data?.code,
        msg: data?.msg,
        data,
      },
    });
  }

  throw new AgentError("Feishu API failed", { code: "FEISHU_API_FAILED" });
};

export const getTenantAccessToken = async (config = getFeishuConfig(), options = {}) => {
  ensureFeishuConfigured(config);
  const data = await feishuRequest(
    "/open-apis/auth/v3/tenant_access_token/internal",
    {
      app_id: config.appId,
      app_secret: config.appSecret,
    },
    config,
    {
      ...options,
      interfaceName: "feishu:tenant-access-token",
    },
  );

  const token = String(data?.tenant_access_token || "");
  if (!token) {
    throw new AgentError("Feishu tenant_access_token is empty", {
      code: "FEISHU_TOKEN_EMPTY",
      status: 500,
      details: data,
    });
  }
  return token;
};

/**
 * 将云文档（多维表格 / 飞书文档）的链接分享权限设置为「互联网任何人获得链接均可编辑」。
 *
 * 背景：当前所有资源都以 tenant_access_token（应用身份）创建，默认归属应用且不公开，
 * 导致同租户成员只有只读、外部用户无法访问。建表 / 建文档后调用本函数统一放开权限。
 *
 * 容错策略：权限设置失败不应中断已完成的导出主流程，因此失败时只记日志并返回
 * { applied: false, error }，由调用方决定是否把错误透传给前端提示。
 *
 * @param {string} token 多维表格的 app_token 或文档的 document_id
 * @param {"bitable"|"docx"} type 资源类型，作为 /public 接口的 type 查询参数
 */
export const setFeishuDocumentPublic = async (
  token,
  type,
  tenantAccessToken,
  config = getFeishuConfig(),
  options = {},
) => {
  const resourceToken = String(token || "").trim();
  if (!resourceToken) {
    return { applied: false, error: "empty token" };
  }

  try {
    const query = new URLSearchParams({ type: type === "docx" ? "docx" : "bitable" });
    await feishuRequest(
      `/open-apis/drive/v1/permissions/${encodeURIComponent(resourceToken)}/public?${query.toString()}`,
      { link_share_entity: "anyone_editable" },
      config,
      {
        ...options,
        method: "PATCH",
        tenantAccessToken,
        interfaceName: "feishu:permission.public",
      },
    );
    options.logger?.info("feishu.permission.public.applied", {
      type,
      token: resourceToken,
      linkShareEntity: "anyone_editable",
    });
    return { applied: true, error: null };
  } catch (error) {
    options.logger?.warn("feishu.permission.public.failed", {
      type,
      token: resourceToken,
      feishuCode: error?.details?.feishuCode,
      msg: error?.message,
    });
    return {
      applied: false,
      error: error?.message || "set public permission failed",
    };
  }
};

const trimTitle = (value) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 120) || `小芒最终文案 ${new Date().toISOString().slice(0, 10)}`;
};

export const createFeishuDocument = async ({ title }, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const body = {
    title: trimTitle(title),
    ...(config.folderToken ? { folder_token: config.folderToken } : {}),
  };
  const data = await feishuRequest("/open-apis/docx/v1/documents", body, config, {
    ...options,
    tenantAccessToken,
    interfaceName: "feishu:docx.create",
  });
  const document = data?.data?.document || {};
  if (!document.document_id) {
    throw new AgentError("Feishu document_id is empty", {
      code: "FEISHU_DOCUMENT_EMPTY",
      status: 500,
      details: data,
    });
  }
  return document;
};

const textElement = (content) => ({
  text_run: {
    content: String(content || ""),
  },
});

const textPayload = (content) => ({
  elements: [textElement(content)],
  style: {},
});

const makeBlock = (blockType, field, content) => ({
  block_type: blockType,
  [field]: textPayload(content),
});

const splitText = (value, maxLength = MAX_TEXT_LENGTH) => {
  const text = String(value || "");
  if (text.length <= maxLength) return [text];
  const chunks = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
};

export const markdownToFeishuBlocks = (markdown) => {
  const lines = String(markdown || "").split(/\r?\n/);
  const blocks = [];

  lines.forEach((rawLine) => {
    const line = rawLine.trimEnd();
    if (!line.trim()) return;
    if (/^-{3,}$/.test(line.trim())) return;

    const heading2 = line.match(/^##\s+(.+)/);
    if (heading2?.[1]) {
      blocks.push(makeBlock(4, "heading2", heading2[1].trim()));
      return;
    }

    const heading1 = line.match(/^#\s+(.+)/);
    if (heading1?.[1]) {
      blocks.push(makeBlock(3, "heading1", heading1[1].trim()));
      return;
    }

    splitText(line.trim()).forEach((chunk) => {
      blocks.push(makeBlock(2, "text", chunk));
    });
  });

  return blocks.length > 0 ? blocks : [makeBlock(2, "text", " ")];
};

const chunkArray = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

export const appendBlocksToFeishuDocument = async (documentId, blocks, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const chunks = chunkArray(blocks, MAX_BLOCKS_PER_REQUEST);
  let createdCount = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const query = new URLSearchParams({
      document_revision_id: "-1",
      client_token: randomUUID(),
    });
    const path = `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children?${query.toString()}`;

    const data = await feishuRequest(path, { children: chunks[index] }, config, {
      ...options,
      tenantAccessToken,
      interfaceName: "feishu:docx.blocks.create",
    });

    createdCount += Array.isArray(data?.data?.children) ? data.data.children.length : chunks[index].length;

    if (index < chunks.length - 1) {
      await sleep(420);
    }
  }

  return createdCount;
};

const buildDocumentUrl = (documentId, config) => `${config.docBaseUrl}/docx/${documentId}`;

const titleFromDraft = (draft) => {
  const firstTitle = String(draft?.titleDraft || "")
    .split(/\r?\n/)
    .map(item => item.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean)[0];
  return trimTitle(firstTitle || `小芒最终文案 ${new Date().toISOString().slice(0, 10)}`);
};

export const writeFinalDraftToFeishu = async (draft = {}, options = {}) => {
  const config = options.config || getFeishuConfig();
  ensureFeishuConfigured(config);

  // 支持两种入参：
  //   · 单条草稿对象（内容生成页旧调用）；
  //   · `{ items: [...] }`（发布仓 / 内容页的「全部已保存记录」）。
  const items = Array.isArray(draft?.items) ? draft.items.filter(Boolean) : [];
  const markdown = items.length > 0
    ? buildFinalDraftMarkdownForItems(items)
    : buildFinalDraftMarkdown(draft);
  const tenantAccessToken = await getTenantAccessToken(config, options);
  const document = await createFeishuDocument(
    { title: titleFromDraft(items[0] || draft) },
    tenantAccessToken,
    config,
    options,
  );
  const blocks = markdownToFeishuBlocks(markdown);
  const blocksCreated = await appendBlocksToFeishuDocument(
    document.document_id,
    blocks,
    tenantAccessToken,
    config,
    options,
  );

  // 新建的飞书文档默认归属应用且不公开，统一放开为「互联网任何人获得链接均可编辑」。
  const permissionResult = await setFeishuDocumentPublic(document.document_id, "docx", tenantAccessToken, config, options);

  return {
    documentId: document.document_id,
    revisionId: document.revision_id,
    title: document.title,
    documentUrl: buildDocumentUrl(document.document_id, config),
    blocksCreated,
    markdown,
    permissionApplied: permissionResult.applied,
    permissionError: permissionResult.error,
  };
};

const BITABLE_TABLE_NAME = "选题复盘";
const BITABLE_VIEW_NAME = "运营复盘视图";
const BITABLE_TEXT_LIMIT = 50000;
const FEISHU_DUPLICATE_TABLE_CODES = new Set([
  "TableNameDuplicated",
  "DuplicateTableName",
]);

/**
 * 多维表格的列（**顺序即用户口径，别自己重排**，2026-09-24 用户给的清单）。
 *
 * 与旧版的差异（用户要求按这一版改）：
 *   - 改名：选题标题→对标视频标题、收藏数→收藏数（红心）、三秒留存→生成3秒、
 *           二创文案→原二创文案、发布封面→封面
 *   - 新增：原文案（对标视频提取到的原文）、生成结尾钩子（与 3 秒分开两列）
 *   - 合并：发布文案＋发布标签 → 一列「发布仓（发布文案＋发布标签）」
 *   - 移除：视频封面 / 视频时长 / 发布时间 / 热词 / 风格转写结果 / 中英翻译结果 / 导出时间
 *
 * 类型：文本 1、数字 2、URL 15。
 * ⚠️「封面」用**文本**列而不是 URL 列：出图可能只回 base64，那种情况没有外链可放，
 *    URL 列会直接空掉 —— 客户就看不出这条到底出没出图。文本列能如实写「内嵌图片（无外链）」。
 */
export const BITABLE_FIELDS = [
  { field_name: "对标视频标题", type: 1 },
  { field_name: "视频链接", type: 15 },
  { field_name: "作者", type: 1 },
  { field_name: "点赞数", type: 2 },
  { field_name: "评论数", type: 2 },
  { field_name: "转发数", type: 2 },
  { field_name: "收藏数（红心）", type: 2 },
  { field_name: "原文案", type: 1 },
  { field_name: "原二创文案", type: 1 },
  { field_name: "生成标题", type: 1 },
  { field_name: "生成3秒", type: 1 },
  { field_name: "生成结尾钩子", type: 1 },
  { field_name: "发布仓（发布文案＋发布标签）", type: 1 },
  { field_name: "封面", type: 1 },
];

const limitCellText = (value) => {
  const text = String(value || "").trim();
  if (text.length <= BITABLE_TEXT_LIMIT) return text;
  return `${text.slice(0, BITABLE_TEXT_LIMIT)}\n（内容过长，已截断）`;
};

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const trimBitableName = (value, fallback = BITABLE_TABLE_NAME) => {
  const text = String(value || "")
    .replace(/[\\/:*?"<>|#%&{}$!@'+=`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || fallback).slice(0, 80);
};

export const parseFeishuBitableUrl = (value) => {
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = new URL(text);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const baseIndex = parts.findIndex(part => part === "base");
    if (baseIndex >= 0 && parts[baseIndex + 1]) {
      return {
        appToken: parts[baseIndex + 1],
        tableId: parsed.searchParams.get("table") || "",
        viewId: parsed.searchParams.get("view") || "",
      };
    }
  } catch {
    // fall through to token-like parsing
  }

  const tokenMatch = text.match(/\b(app[a-zA-Z0-9]{8,})\b/);
  return tokenMatch ? { appToken: tokenMatch[1], tableId: "", viewId: "" } : {};
};

const titleFromDraftContent = (draft) => {
  const firstTitle = String(draft?.titleDraft || "")
    .split(/\r?\n/)
    .map(item => item.replace(/^\d+\.\s*/, "").trim())
    .filter(Boolean)[0];
  return firstTitle || "未命名选题";
};

const linkField = (link, text) => {
  const url = String(link || "").trim();
  if (!url) return null;
  return {
    text: String(text || url).slice(0, 100),
    link: url,
  };
};

export const finalDraftToBitableRecords = (draft = {}) => {
  const benchmarkVideos = normalizeBenchmarkVideos(draft.benchmarkVideos);
  const videos = benchmarkVideos.length > 0
    ? benchmarkVideos
    : [
        {
          title: titleFromDraftContent(draft),
          link: "",
          coverUrl: "",
          durationSeconds: 0,
          authorName: "",
          publishDate: "",
          likes: 0,
          comments: 0,
          shares: 0,
          bookmarks: 0,
          hotTopics: [],
        },
      ];

  const publishCells = publishWarehouseCells(draft?.publishWarehouse);
  // 「发布仓（发布文案＋发布标签）」是**一列**：发布文案一段、发布标签一段，中间空一行。
  const publishCell = [publishCells.copy, publishCells.tags].filter(Boolean).join("\n");

  return videos.map((video, index) => {
    const fields = {
      "对标视频标题": limitCellText(video.title || `选题 ${index + 1}`),
      "作者": limitCellText(video.authorName || ""),
      "点赞数": numberValue(video.likes),
      "评论数": numberValue(video.comments),
      "转发数": numberValue(video.shares),
      "收藏数（红心）": numberValue(video.bookmarks),
      // 原文案 = 这条对标视频**提取到的原文**（口播转写或平台文案，见 scriptSource）。
      // 它和二创结果是两回事，所以单独一列，别拿标题去凑。
      "原文案": limitCellText(video.script),
      "原二创文案": limitCellText(draft.scriptDraft),
      "生成标题": limitCellText(draft.titleDraft),
      // 3 秒与结尾钩子**分成两列**：它们本来就是两类东西，旧版混在「三秒留存」一格里。
      "生成3秒": limitCellText(draft.hookDraft),
      "生成结尾钩子": limitCellText(draft.endingHookDraft),
      "发布仓（发布文案＋发布标签）": limitCellText(publishCell),
      "封面": limitCellText(publishCells.cover),
    };

    const videoLink = linkField(video.link, video.title || "对标视频");
    if (videoLink) fields["视频链接"] = videoLink;

    return { fields };
  });
};

export const createFeishuBitableApp = async ({ name }, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const body = {
    name: trimTitle(name || `小芒选题复盘 ${new Date().toISOString().slice(0, 10)}`),
    ...(config.folderToken ? { folder_token: config.folderToken } : {}),
    time_zone: "Asia/Shanghai",
  };
  const data = await feishuRequest("/open-apis/bitable/v1/apps", body, config, {
    ...options,
    tenantAccessToken,
    interfaceName: "feishu:bitable.app.create",
  });
  const app = data?.data?.app || {};
  if (!app.app_token) {
    throw new AgentError("Feishu bitable app_token is empty", {
      code: "FEISHU_BITABLE_APP_EMPTY",
      status: 500,
      details: data,
    });
  }
  return app;
};

const findFeishuBitableTableByName = async (appToken, tableName, tenantAccessToken, config, options) => {
  const data = await feishuRequest(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    null,
    config,
    {
      ...options,
      method: "GET",
      tenantAccessToken,
      interfaceName: "feishu:bitable.tables.list",
    },
  );

  const items = Array.isArray(data?.data?.items) ? data.data.items : [];
  return items.find((item) => String(item?.name || "").trim() === tableName) || null;
};

export const createFeishuBitableTable = async (appToken, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const tableName = trimBitableName(options.tableName || BITABLE_TABLE_NAME);
  try {
    const data = await feishuRequest(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
      {
        table: {
          name: tableName,
          default_view_name: BITABLE_VIEW_NAME,
          fields: BITABLE_FIELDS,
        },
      },
      config,
      {
        ...options,
        tenantAccessToken,
        interfaceName: "feishu:bitable.table.create",
      },
    );
    const tableId = String(data?.data?.table_id || "");
    if (!tableId) {
      throw new AgentError("Feishu bitable table_id is empty", {
        code: "FEISHU_BITABLE_TABLE_EMPTY",
        status: 500,
        details: data,
      });
    }
    return {
      tableId,
      defaultViewId: data?.data?.default_view_id || "",
      fieldIdList: Array.isArray(data?.data?.field_id_list) ? data.data.field_id_list : [],
      tableName,
      reused: false,
    };
  } catch (error) {
    const feishuCode = String(error?.details?.feishuCode || error?.details?.code || error?.code || "");
    if (!FEISHU_DUPLICATE_TABLE_CODES.has(feishuCode)) {
      throw error;
    }

    const existingTable = await findFeishuBitableTableByName(appToken, tableName, tenantAccessToken, config, options);
    if (!existingTable?.table_id) {
      throw error;
    }

    return {
      tableId: String(existingTable.table_id),
      defaultViewId: String(existingTable.default_view_id || ""),
      fieldIdList: Array.isArray(existingTable.field_id_list) ? existingTable.field_id_list : [],
      tableName,
      reused: true,
    };
  }
};

export const listFeishuBitableFields = async (appToken, tableId, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const fields = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      page_size: "100",
      ...(pageToken ? { page_token: pageToken } : {}),
    });
    const data = await feishuRequest(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query.toString()}`,
      null,
      config,
      {
        ...options,
        method: "GET",
        tenantAccessToken,
        interfaceName: "feishu:bitable.fields.list",
      },
    );

    const items = Array.isArray(data?.data?.items) ? data.data.items : [];
    fields.push(...items);
    pageToken = data?.data?.has_more ? String(data?.data?.page_token || "") : "";
  } while (pageToken);

  return fields;
};

export const createFeishuBitableField = async (appToken, tableId, field, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const query = new URLSearchParams({
    client_token: randomUUID(),
  });
  const data = await feishuRequest(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields?${query.toString()}`,
    field,
    config,
    {
      ...options,
      tenantAccessToken,
      interfaceName: "feishu:bitable.fields.create",
    },
  );
  return data?.data?.field || null;
};

export const ensureFeishuBitableFields = async (appToken, tableId, tenantAccessToken, config = getFeishuConfig(), options = {}) => {
  const existingFields = await listFeishuBitableFields(appToken, tableId, tenantAccessToken, config, options);
  const existingNames = new Set(existingFields.map(field => String(field?.field_name || "").trim()).filter(Boolean));
  const missingFields = BITABLE_FIELDS.filter(field => !existingNames.has(field.field_name));
  const createdFields = [];

  for (let index = 0; index < missingFields.length; index += 1) {
    const field = await createFeishuBitableField(appToken, tableId, missingFields[index], tenantAccessToken, config, options);
    if (field) createdFields.push(field);
    if (index < missingFields.length - 1) {
      await sleep(420);
    }
  }

  return {
    existingCount: existingFields.length,
    missingCount: missingFields.length,
    createdCount: createdFields.length,
  };
};

/**
 * 为任务绑定流程创建一份全新的飞书多维表格应用，并自动建好「选题复盘」数据表与字段。
 * 与 writeFinalDraftToFeishuBitable 不同：本函数不写入任何选题记录，仅完成建表与字段，
 * 供前端「创建新多维表格」按钮立即拿到 appToken/tableId/bitableUrl 完成绑定。
 */
export const createFeishuBitableForTask = async (payload = {}, options = {}) => {
  const config = options.config || getFeishuConfig();
  ensureFeishuConfigured(config);

  const tenantAccessToken = await getTenantAccessToken(config, options);
  const taskInfo = payload?.taskInfo || payload?.task || {};
  const requestedTableName = trimBitableName(
    payload?.tableName ||
      [taskInfo?.customerName, taskInfo?.platformName, "选题复盘"].filter(Boolean).join(" - ") ||
      BITABLE_TABLE_NAME,
  );
  const appName = trimTitle(
    payload?.name ||
      `小芒选题复盘 ${new Date().toISOString().slice(0, 10)}`,
  );

  const app = await createFeishuBitableApp({ name: appName }, tenantAccessToken, config, options);
  const appToken = app.app_token;
  const appUrl = app.url || "";

  const table = await createFeishuBitableTable(appToken, tenantAccessToken, config, {
    ...options,
    tableName: requestedTableName,
  });
  const tableId = table.tableId;

  const fieldResult = await ensureFeishuBitableFields(appToken, tableId, tenantAccessToken, config, options);

  // 新建的多维表格默认归属应用且不公开，这里统一放开为「互联网任何人获得链接均可编辑」。
  const permissionResult = await setFeishuDocumentPublic(appToken, "bitable", tenantAccessToken, config, options);

  return {
    appToken,
    tableId,
    tableName: requestedTableName,
    bitableUrl: buildBitableUrl(appToken, tableId, appUrl, config),
    appCreated: true,
    tableCreated: !table.reused,
    fieldsCreated: fieldResult.createdCount,
    permissionApplied: permissionResult.applied,
    permissionError: permissionResult.error,
  };
};

export const batchCreateFeishuBitableRecords = async (
  appToken,
  tableId,
  records,
  tenantAccessToken,
  config = getFeishuConfig(),
  options = {},
) => {
  const query = new URLSearchParams({
    client_token: randomUUID(),
    ignore_consistency_check: "true",
  });
  const data = await feishuRequest(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/batch_create?${query.toString()}`,
    { records },
    config,
    {
      ...options,
      tenantAccessToken,
      interfaceName: "feishu:bitable.records.batch_create",
    },
  );
  return Array.isArray(data?.data?.records) ? data.data.records : [];
};

const buildBitableUrl = (appToken, tableId, fallbackUrl, config) => {
  if (!appToken) return fallbackUrl || "";
  const base = `${config.docBaseUrl}/base/${appToken}`;
  return tableId ? `${base}?table=${tableId}` : base;
};

export const writeFinalDraftToFeishuBitable = async (draft = {}, options = {}) => {
  const config = options.config || getFeishuConfig();
  ensureFeishuConfigured(config);

  const tenantAccessToken = await getTenantAccessToken(config, options);
  // `{ items: [...] }` = 多条已保存记录（发布仓 / 内容页导出）；否则按单条草稿处理。
  const sourceItems = Array.isArray(draft?.items) && draft.items.length > 0 ? draft.items.filter(Boolean) : [draft];
  const records = sourceItems.flatMap(item => finalDraftToBitableRecords(item));
  const urlTarget = parseFeishuBitableUrl(draft?.feishuBitable?.targetUrl || draft?.targetUrl || draft?.feishuBitableUrl || "");
  const taskInfo = draft?.taskInfo || draft?.task || {};
  const requestedTableName = trimBitableName(
    draft?.feishuBitable?.tableName ||
      taskInfo?.tableName ||
      [taskInfo?.customerName, taskInfo?.platformName, "选题复盘"].filter(Boolean).join(" - ") ||
      BITABLE_TABLE_NAME,
  );

  let appToken = String(draft?.feishuBitable?.appToken || urlTarget.appToken || config.bitableAppToken || "").trim();
  let tableId = String(draft?.feishuBitable?.tableId || urlTarget.tableId || config.bitableTableId || "").trim();
  let appUrl = "";
  let appCreated = false;
  let tableCreated = false;
  let fieldsCreated = 0;

  if (!appToken) {
    const app = await createFeishuBitableApp(
      { name: `小芒选题复盘 ${new Date().toISOString().slice(0, 10)}` },
      tenantAccessToken,
      config,
      options,
    );
    appToken = app.app_token;
    appUrl = app.url || "";
    appCreated = true;
  }

  if (!tableId) {
    const table = await createFeishuBitableTable(appToken, tenantAccessToken, config, {
      ...options,
      tableName: requestedTableName,
    });
    tableId = table.tableId;
    tableCreated = !table.reused;
  }

  const fieldResult = await ensureFeishuBitableFields(appToken, tableId, tenantAccessToken, config, options);
  fieldsCreated = fieldResult.createdCount;

  const createdRecords = await batchCreateFeishuBitableRecords(
    appToken,
    tableId,
    records,
    tenantAccessToken,
    config,
    options,
  );

  // 仅对本次新建的多维表格放开「互联网任何人获得链接均可编辑」权限；
  // 复用用户已绑定的表格时保留其原有权限，不强行覆盖。
  let permissionApplied = null;
  let permissionError = null;
  if (appCreated) {
    const permissionResult = await setFeishuDocumentPublic(appToken, "bitable", tenantAccessToken, config, options);
    permissionApplied = permissionResult.applied;
    permissionError = permissionResult.error;
  }

  return {
    appToken,
    tableId,
    bitableUrl: buildBitableUrl(appToken, tableId, appUrl, config),
    recordCount: records.length,
    recordsCreated: createdRecords.length || records.length,
    appCreated,
    tableCreated,
    fieldsCreated,
    tableName: requestedTableName,
    permissionApplied,
    permissionError,
  };
};
