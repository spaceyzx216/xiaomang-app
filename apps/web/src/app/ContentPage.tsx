import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { apiUrl, fetchWithRetry } from "./api";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { Checkbox } from "./components/ui/checkbox";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./components/ui/accordion";
import { Loader2, Layers, CheckCircle2, Sparkles, ChevronLeft, ChevronRight, Download, Link2, Plus, Unlink } from "lucide-react";
import { clearCachedFinalDrafts, readCachedFinalDrafts } from "./finalDraftCache";
import { ConfirmDialog } from "../components/common/ConfirmDialog";
import {
  CONTENT_TOPIC_CONCURRENCY,
  CONTENT_TOPIC_TIMEOUT_MS,
  findWorkflowGroupIndex,
  hasWorkflowResult,
  isFatalWorkflowError,
  orderWorkflowGroupsByLinks,
  pickReusableWorkflowGroups,
  sameLink,
} from "./contentWorkflowRun";
import { mapWithConcurrency } from "./topicAnalysisPipeline";
import { compactTopicLabel, editorPayloadFromDraft, filterExportDrafts, hasDraftExportContent, pickDraftExportBlock, sameDraftSelection, sameDraftTopic, withCurrentPublishSelection } from "./draftExport";
import { getAccountTags, listPublishSelections } from "./publishWarehouseApi";

type TopicLike = {
  id?: string;
  platform?: "douyin" | "wechat_channels" | "tiktok";
  title?: string;
  authorName?: string;
  link?: string;
  stats?: {
    comments?: number;
    likes?: number;
    shares?: number;
    bookmarks?: number;
  };
  publishDate?: string;
  hotTopics?: string[];
  /**
   * 「今日选题」带过来的脚本与库内标签（2026-09-21）。
   *
   * 近 7 天的视频在那边已经**语音提取过完整脚本**，这里直接用，
   * **不要再提取一次** —— 这正是用户在选题页做提取的目的。
   */
  content?: {
    script?: string;
    scriptSource?: "transcript" | "caption";
    categoryName?: string;
    subcategoryName?: string;
    categoryId?: string;
    confidence?: string;
    basis?: string;
  };
  source?: {
    platform?: string;
    objectId?: string;
    objectNonceId?: string;
    finderUsername?: string;
    mediaUrl?: string;
    decodeKey?: string;
    coverUrl?: string;
  };
  rawData?: any;
};

type BenchmarkVideo = {
  title: string;
  link: string;
  coverUrl: string;
  durationSeconds: number;
  authorName: string;
  publishDate: string;
  likes: number;
  comments: number;
  shares: number;
  bookmarks: number;
  hotTopics: string[];
  /** 已提取的完整口播脚本（近 7 天的视频由「今日选题」页提取好带过来）。 */
  script?: string;
  scriptSource?: "transcript" | "caption";
  /** 本账号选题库的大类 / 小类标签。 */
  categoryName?: string;
  subcategoryName?: string;
};

type WorkflowHook = {
  id: string;
  content: string;
  hookType: "opening_text" | "ending_text" | "unknown";
  /**
   * 该候选所属的三秒 / 结尾钩子类型（如「求知欲」「引导互动」）。
   *
   * 只有**按选题库配比生成**的候选才有这个字段 —— 它们是后端逐槽位指定类型生成的，
   * 类型就是「10 条按 40/30/20/10 分配」的落地证据。旧的自由二创候选没有类型，
   * 所以这里是可选的，渲染时按需显示。
   */
  hookTypeLabel?: string;
};

type WorkflowResult = {
  titles: string[];
  hooks: WorkflowHook[];
  scripts: Array<{ id: string; title: string; content: string }>;
};

type WorkflowResultGroup = {
  id: string;
  shareLink: string;
  result: WorkflowResult;
};

type RunWorkflowOptions = {
  force?: boolean;
};

type TranslationItem = {
  id: string;
  zh: string;
  en: string;
  sourceType: "title" | "hook" | "script";
  original?: string;
  translated?: string;
};

type RewritePlatform = "douyin" | "xiaohongshu" | "wechat";

/**
 * 服务端持久化的「按选题保存」草稿（`/api/final-drafts`）。
 *
 * 与浏览器 sessionStorage 的 `finalDraftPayload` 是两回事：那个只服务「当前这条 →
 * 最终编辑页」的单次交接，一刷新就没了；这里按 owner/customer/task/topic 落库，
 * 用来做「保存后一直保留、切题能恢复、不经过发布仓也能导出」。
 */
type SavedDraftSelection = {
  selectedTitles?: string[];
  selectedHooks?: string[];
  selectedScripts?: string[];
  rewriteSelection?: string[];
  rewriteResults?: Array<{ id: string; original: string; rewritten: string; target: RewritePlatform }>;
  translationItems?: TranslationItem[];
  rewriteEnabled?: boolean;
  translationEnabled?: boolean;
  rewriteTarget?: RewritePlatform;
  sourceGroupId?: string;
  sourceGroupIndex?: number;
  totalGroups?: number;
};

type SavedDraftItem = {
  id: string;
  createdAt: string;
  updatedAt?: string;
  ownerId?: string;
  customerId?: string;
  taskId?: string;
  topic?: { id?: string; title?: string; shareLink?: string; platform?: string };
  titleDraft?: string;
  hookDraft?: string;
  endingHookDraft?: string;
  scriptDraft?: string;
  rewriteDraft?: string;
  translationDraft?: string;
  benchmarkVideos?: BenchmarkVideo[];
  selection?: SavedDraftSelection;
  publishWarehouse?: any;
};

const fallbackResult: WorkflowResult = {
  titles: [],
  hooks: [],
  scripts: [],
};

const loadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/**
 * 写 sessionStorage 但**不让失败冒泡**。
 *
 * 几十条选题的结果加起来可能有几百 KB；隐私模式 / 配额超限时 `setItem` 会抛异常。
 * 这条链路里内存 state 已经是准的，缓存失败最多是「刷新后恢复不了」，
 * 不能反过来把一条已经生成成功的选题标成失败。
 */
const safeSessionSet = (key: string, value: string) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 忽略：缓存只用于刷新恢复
  }
};

const safeSessionRemove = (key: string) => {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // 忽略：缓存只用于刷新恢复
  }
};

const mockStyles = [
  {
    id: "style-1",
    label: "专业理性",
    text: "突出数据优势，强调方案可行性与执行路径。",
  },
  {
    id: "style-2",
    label: "轻量口播",
    text: "用简洁语言突出卖点，强调易理解与易传播。",
  },
];

const splitByLine = (input?: string) =>
  String(input || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);

/**
 * 读出「按选题库配比生成的候选」（`{ index, type, typeLabel, content }`）。
 *
 * 🔴 本轮（2026-09-21 第六轮）之前，解析只认 `extracted` / `created`（三秒）
 * 与 `extracted_result` / `rcs`（结尾），**`candidates` 会被静默丢掉** ——
 * 后端明明按配比生成了 10 条，用户却一条都看不到（不报错，看起来像没生效）。
 *
 * ⚠️ 这个文件的解析逻辑在下面有**两份**（当前任务 / 分组的），
 * 抽成 helper 就是为了不让它们各自漂移。改这里两份一起生效。
 */
const readHookCandidates = (raw: any): Array<{ content: string; typeLabel: string }> => {
  if (!Array.isArray(raw?.candidates)) return [];
  return raw.candidates
    .map((item: any) => ({
      content: String(item?.content || "").trim(),
      typeLabel: String(item?.typeLabel || item?.type || "").trim(),
    }))
    .filter((item: { content: string }) => Boolean(item.content));
};

const toPreview = (text: string, max = 80) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

const normalizeTitleLine = (line: string) =>
  String(line || "")
    .replace(/^[-]{2,}\s*$/, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/^\*+\s*/, "")
    .replace(/\*+$/, "")
    .trim();

const extractQuotedTitle = (line: string) => {
  const match = String(line || "").match(/《([^》]+)》/);
  return match?.[1]?.trim() || "";
};

const splitInlineTitleDetail = (value: string) => {
  const text = normalizeTitleLine(value);
  const detailStart = text.search(/(?:类型|优势|技巧)[:：]|【/);
  if (detailStart < 0) return { title: text.trim(), rest: "" };
  return {
    title: text.slice(0, detailStart).trim(),
    rest: text.slice(detailStart).trim(),
  };
};

const normalizeTitleType = (value: string) =>
  normalizeTitleLine(value)
    .replace(/[+＋/|]/g, "、")
    .replace(/\s*、\s*/g, "、")
    .replace(/^类型[:：]\s*/, "")
    .replace(/[。；;，,]\s*$/, "")
    .trim();

const readInlineField = (text: string, label: "类型" | "优势" | "技巧") => {
  const pattern = new RegExp(`${label}[:：]\\s*([\\s\\S]*?)(?=(?:类型|优势|技巧)[:：]|$)`);
  const matched = text.match(pattern)?.[1] || "";
  return normalizeTitleLine(matched)
    .replace(/[。；;]\s*$/, "")
    .trim();
};

const parseTitleStartLine = (line: string) => {
  const normalized = normalizeTitleLine(line)
    .replace(/^\d+\s*[\.、]?\s*/, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/^标题\s*/, "")
    .trim();
  const quoted = extractQuotedTitle(normalized);
  const closeIndex = normalized.indexOf("》");
  const restAfterQuote = quoted && closeIndex >= 0 ? normalized.slice(closeIndex + 1).trim() : "";
  const split = quoted ? { title: quoted, rest: restAfterQuote } : splitInlineTitleDetail(normalized);
  const bracketType = split.rest.match(/【([^】]+)】/)?.[1] || "";

  return {
    title: split.title.replace(/^《?\s*/, "").replace(/\s*》?$/, "").trim(),
    type: normalizeTitleType(readInlineField(split.rest, "类型") || bracketType),
    advantage: readInlineField(split.rest, "优势"),
    skill: readInlineField(split.rest, "技巧"),
  };
};

const parseTitleBlocks = (titleText: string) => {
  const lines = splitByLine(titleText)
    .map(normalizeTitleLine)
    .filter(Boolean)
    .filter(line => !line.includes("爆款标题") && line !== "---");

  const blocks: Array<{ title: string; type: string; advantage: string; skill: string }> = [];
  let current: { title: string; type: string; advantage: string; skill: string } | null = null;

  const pushCurrent = () => {
    if (!current?.title) return;
    blocks.push({ ...current });
  };

  for (const line of lines) {
    const isBlockStart = /^\d+\s*[\.、]/.test(line) || /^标题[:：]/.test(line);

    if (isBlockStart) {
      pushCurrent();
      current = parseTitleStartLine(line);
      continue;
    }

    if (!current) continue;

    if (/^\*?\*?标题\*?\*?[:：]/.test(line)) {
      const parsed = parseTitleStartLine(line.replace(/^\*?\*?标题\*?\*?[:：]\s*/, ""));
      current.title = parsed.title || current.title;
      current.type ||= parsed.type;
      current.advantage ||= parsed.advantage;
      current.skill ||= parsed.skill;
      continue;
    }

    if (/^\*?\*?类型\*?\*?[:：]/.test(line)) {
      current.type = normalizeTitleType(line.replace(/^\*?\*?类型\*?\*?[:：]\s*/, ""));
      continue;
    }

    if (/^\*?\*?优势\*?\*?[:：]/.test(line)) {
      current.advantage = line.replace(/^\*?\*?优势\*?\*?[:：]\s*/, "").trim();
      continue;
    }

    if (/^\*?\*?技巧\*?\*?[:：]/.test(line)) {
      current.skill = line.replace(/^\*?\*?技巧\*?\*?[:：]\s*/, "").trim();
      continue;
    }
  }

  pushCurrent();

  return blocks.map((item, index) => {
    const detailLines = [
      item.type ? `类型：${item.type}` : "",
      item.advantage ? `优势：${item.advantage}` : "",
      item.skill ? `技巧：${item.skill}` : "",
    ].filter(Boolean);

    const titleLine = `${index + 1}. ${item.title}`;
    return [titleLine, ...detailLines].join("\n");
  });
};

const extractTitleLabel = (titleBlock: string) => {
  const firstLine = normalizeTitleLine(splitByLine(titleBlock)[0] || "");
  const parsed = parseTitleStartLine(firstLine);
  if (parsed.title) return parsed.title;
  const quoted = extractQuotedTitle(firstLine);
  if (quoted) return quoted;
  return firstLine
    .replace(/^\d+\s*[\.、]?\s*/, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/^《?\s*/, "")
    .replace(/\s*》?$/, "")
    .trim();
};

const formatTitleDisplay = (titleBlock: string) => {
  const lines = splitByLine(titleBlock);
  const firstLine = normalizeTitleLine(lines[0] || "");
  const parsed = parseTitleStartLine(firstLine);
  const fallbackLabel = extractTitleLabel(titleBlock);
  const inlineDetailLines = [
    parsed.type ? `类型：${parsed.type}` : "",
    parsed.advantage ? `优势：${parsed.advantage}` : "",
    parsed.skill ? `技巧：${parsed.skill}` : "",
  ].filter(Boolean);

  return {
    titleLabel: parsed.title || fallbackLabel || titleBlock,
    detailLines: lines.length > 1 ? lines.slice(1) : inlineDetailLines,
  };
};

const getTopicShareLink = (topic: TopicLike) => {
  const rawData = topic?.rawData || {};
  return (
    rawData?.share_info?.share_url ||
    rawData?.share_url ||
    rawData?.video?.play_addr?.url_list?.[0] ||
    topic?.link ||
    ""
  );
};

const isWeChatChannelsTopic = (topic: TopicLike) =>
  topic?.platform === "wechat_channels" ||
  topic?.source?.platform === "wechat_channels" ||
  topic?.rawData?.platform === "wechat_channels";

const getTopicWorkflowKey = (topic: TopicLike) => {
  if (!isWeChatChannelsTopic(topic)) return getTopicShareLink(topic);
  const rawData = topic?.rawData || {};
  const source = topic?.source || {};
  const id =
    source.objectId ||
    rawData.id ||
    rawData.object_id ||
    rawData.objectId ||
    topic.id ||
    source.objectNonceId ||
    rawData.object_nonce_id ||
    rawData.objectNonceId ||
    topic.title ||
    "topic";
  return `wechat_channels:${String(id).replace(/^wechat_channels:/, "")}`;
};

const describeTopicSource = (topic: TopicLike) => {
  if (!isWeChatChannelsTopic(topic)) return getTopicShareLink(topic);
  const source = topic?.source || {};
  return [
    source.finderUsername ? `finderUsername: ${source.finderUsername}` : "",
    source.objectId ? `objectId: ${source.objectId}` : "",
    source.objectNonceId ? `objectNonceId: ${source.objectNonceId}` : "",
  ].filter(Boolean).join(" / ");
};

const toNumber = (value: any) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const readStat = (topic: TopicLike, statKey: keyof NonNullable<TopicLike["stats"]>, rawKeys: string[]) => {
  const rawData = topic?.rawData || {};
  const statBlocks = [
    topic?.stats,
    rawData?.statistics,
    rawData?.stats,
    rawData?.statistics_data,
    rawData?.status,
  ].filter(Boolean);

  for (const block of statBlocks) {
    const direct = (block as any)?.[statKey];
    if (direct !== undefined && direct !== null) return toNumber(direct);
    for (const key of rawKeys) {
      const value = (block as any)?.[key];
      if (value !== undefined && value !== null) return toNumber(value);
    }
  }
  return 0;
};

const normalizePublishDate = (value: any) => {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value);
};

const firstHttpUrl = (...values: any[]): string => {
  for (const value of values) {
    if (Array.isArray(value)) {
      const nested = firstHttpUrl(...value);
      if (nested) return nested;
      continue;
    }
    if (value && typeof value === "object") {
      const nested = firstHttpUrl(value.url_list, value.url, value.uri);
      if (nested) return nested;
      continue;
    }
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
};

const normalizeDurationSeconds = (...values: any[]): number => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.round(parsed > 10000 ? parsed / 1000 : parsed);
  }
  return 0;
};

const buildBenchmarkVideos = (topics: TopicLike[]): BenchmarkVideo[] => {
  return topics.map((topic) => {
    const rawData = topic?.rawData || {};
    return {
      title: String(topic?.title || rawData?.desc || rawData?.title || "未命名选题"),
      link: getTopicShareLink(topic),
      coverUrl: firstHttpUrl(
        (topic as any)?.coverUrl,
        (topic as any)?.cover,
        rawData?.cover,
        rawData?.cover_url,
        rawData?.video?.cover,
        rawData?.video?.origin_cover,
        rawData?.video?.dynamic_cover,
        rawData?.video?.animated_cover,
      ),
      durationSeconds: normalizeDurationSeconds(
        (topic as any)?.durationSeconds,
        (topic as any)?.duration,
        rawData?.duration,
        rawData?.video_duration,
        rawData?.video?.duration,
        rawData?.video?.duration_ms,
      ),
      authorName: String(topic?.authorName || rawData?.author?.nickname || rawData?.author_name || "未知"),
      publishDate: normalizePublishDate(topic?.publishDate || rawData?.create_time || rawData?.createTime),
      likes: readStat(topic, "likes", ["digg_count", "like_count", "likes"]),
      comments: readStat(topic, "comments", ["comment_count", "comments"]),
      shares: readStat(topic, "shares", ["share_count", "shares"]),
      bookmarks: readStat(topic, "bookmarks", ["collect_count", "favorite_count", "bookmark_count", "bookmarks"]),
      hotTopics: Array.isArray(topic?.hotTopics) ? topic.hotTopics : [],
      // 脚本与标签由「今日选题」页提取/判定好带过来，二创直接用，不重复提取。
      script: String(topic?.content?.script || ""),
      scriptSource: topic?.content?.scriptSource,
      categoryName: String(topic?.content?.categoryName || ""),
      subcategoryName: String(topic?.content?.subcategoryName || ""),
    };
  });
};

/**
 * 给一条「工作流输入」起一个给人看的名字（失败/待补跑列表用）。
 *
 * 抽到模块级是为了 `runWorkflow` 与渲染层共用同一套口径：左边选题列表用
 * `topic.title`，而这里只有链接 / 视频号 topic，两者必须对得上，否则用户会以为
 * 「未生成 2 条」和失败明细说的是不同选题。
 */
const getWorkflowInputTitle = (
  input: { kind: "share_link" | "wechat_topic"; id: string; link: string; topic: TopicLike | null },
  benchmarkVideos: BenchmarkVideo[],
): string => {
  if (input.kind === "wechat_topic") return String(input.topic?.title || input.id);
  const matched = benchmarkVideos.find(video => sameLink(video.link, input.link));
  return matched?.title || input.link || input.id;
};

const formatMetric = (value: number) => {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return String(value || 0);
};

type BitableBinding = {
  targetUrl?: string;
  appToken?: string;
  tableId?: string;
  tableName?: string;
  bitableUrl?: string;
};

const bitableTaskKey = (task: any) => {
  const raw = String(task?._id || task?.customerName || "default").trim() || "default";
  return `xiaomang.feishuBitable.${raw}`;
};

const readBitableBinding = (key: string): BitableBinding => {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const writeBitableBinding = (key: string, value: BitableBinding) => {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
};

const parseWorkflowPayload = (payloadText: string): WorkflowResult => {
  const text = String(payloadText || "").trim();
  if (!text) return fallbackResult;

  const startIdx = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

  let obj: any = null;
  try {
    obj = JSON.parse(jsonText);
    if (typeof obj?.output === "string") {
      try {
        obj = JSON.parse(obj.output);
      } catch {
        obj = { output: obj.output };
      }
    }
  } catch {
    obj = { output: text };
  }

  const codeListFieldRaw = obj?.Code_list?.[0]?.fields?.[0];
  const codeListField = (() => {
    if (!codeListFieldRaw) return null;
    if (typeof codeListFieldRaw === "string") {
      try {
        return JSON.parse(codeListFieldRaw);
      } catch {
        return null;
      }
    }
    return codeListFieldRaw;
  })();

  const codeList1FieldRaw = obj?.Code_list1?.[0]?.records?.[0]?.fields;
  const codeList1Field = (() => {
    if (!codeList1FieldRaw) return null;
    if (typeof codeList1FieldRaw === "string") {
      try {
        return JSON.parse(codeList1FieldRaw);
      } catch {
        return null;
      }
    }
    return codeList1FieldRaw;
  })();

  const titleText = String(codeListField?.title || codeList1Field?.标题 || obj?.title || "");
  const titleBlocks = parseTitleBlocks(titleText);
  const titles = (titleBlocks.length > 0 ? titleBlocks : splitByLine(titleText))
    .map(item => item.trim())
    .filter(Boolean);

  const openingHookRaw = codeList1Field?.opening_text || codeList1Field?.开头钩子;
  const endingHookRaw = codeList1Field?.ending_text || codeList1Field?.结尾钩子;

  const openingHooks = (() => {
    if (typeof openingHookRaw !== "object" || !openingHookRaw) {
      const single = String(openingHookRaw || "").trim();
      return single ? [{ content: single, typeLabel: "" }] : [];
    }

    const extracted = String(openingHookRaw?.extracted || "").trim();
    const created = Array.isArray(openingHookRaw?.created)
      ? openingHookRaw.created.map((item: any) => String(item || "").trim()).filter(Boolean)
      : [];
    // 按配比生成的候选（带类型）排在自由二创之后，用户先看到「原文提取」，再是配比候选。
    const candidates = readHookCandidates(openingHookRaw);

    return [
      ...(extracted ? [{ content: extracted, typeLabel: "" }] : []),
      ...created.map((content: string) => ({ content, typeLabel: "" })),
      ...candidates,
    ];
  })();

  const endingHooks = (() => {
    if (typeof endingHookRaw !== "object" || !endingHookRaw) {
      const single = String(endingHookRaw || "").trim();
      return single ? [{ content: single, typeLabel: "" }] : [];
    }

    const extracted = String(endingHookRaw?.extracted_result || "").trim();
    const rcs = Array.isArray(endingHookRaw?.rcs)
      ? endingHookRaw.rcs.map((item: any) => String(item || "").trim()).filter(Boolean)
      : [];
    const candidates = readHookCandidates(endingHookRaw);

    return [
      ...(extracted && extracted !== "无" ? [{ content: extracted, typeLabel: "" }] : []),
      ...rcs.map((content: string) => ({ content, typeLabel: "" })),
      ...candidates,
    ];
  })();

  const hooks: WorkflowHook[] = [
    ...openingHooks.map((item, idx) => ({
      id: `hook-opening-${idx + 1}`,
      content: item.content,
      hookType: "opening_text" as const,
      ...(item.typeLabel ? { hookTypeLabel: item.typeLabel } : {}),
    })),
    ...endingHooks.map((item, idx) => ({
      id: `hook-ending-${idx + 1}`,
      content: item.content,
      hookType: "ending_text" as const,
      ...(item.typeLabel ? { hookTypeLabel: item.typeLabel } : {}),
    })),
  ];

  const primaryScriptContent = String(codeListField?.content || "").trim();
  const scripts = primaryScriptContent
    ? [
        {
          id: "script-1",
          title: "二创文案",
          content: primaryScriptContent,
        },
      ]
    : [];

  if (titles.length === 0 && hooks.length === 0 && scripts.length === 0) {
    const outputText = String(obj?.output || text || "");
    if (!outputText) return fallbackResult;
    return {
      titles: fallbackResult.titles,
      hooks: fallbackResult.hooks,
      scripts: [
        {
          id: "script-1",
          title: "工作流原始输出",
          content: outputText,
        },
      ],
    };
  }

  return {
    titles: titles.length > 0 ? titles : fallbackResult.titles,
    hooks: hooks.length > 0 ? hooks : fallbackResult.hooks,
    scripts: scripts.length > 0 ? scripts : fallbackResult.scripts,
  };
};

const parseWorkflowPayloadGroups = (payloadText: string, links: string[]): WorkflowResultGroup[] => {
  const text = String(payloadText || "").trim();
  if (!text || links.length === 0) return [];

  const startIdx = text.indexOf("{");
  const endIdx = text.lastIndexOf("}");
  const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

  let obj: any = null;
  try {
    obj = JSON.parse(jsonText);
    if (typeof obj?.output === "string") {
      try {
        obj = JSON.parse(obj.output);
      } catch {
        obj = { output: obj.output };
      }
    }
  } catch {
    obj = { output: text };
  }

  const listFromCodeList = Array.isArray(obj?.Code_list) ? obj.Code_list : [];
  const listFromCodeList1 = Array.isArray(obj?.Code_list1) ? obj.Code_list1 : [];

  const results = links.map((shareLink, index) => {
    const codeItemRaw = listFromCodeList[index]?.fields?.[0];
    const codeItem = (() => {
      if (!codeItemRaw) return null;
      if (typeof codeItemRaw === "string") {
        try {
          return JSON.parse(codeItemRaw);
        } catch {
          return null;
        }
      }
      return codeItemRaw;
    })();

    const code1ItemRaw = listFromCodeList1[index]?.records?.[0]?.fields;
    const code1Item = (() => {
      if (!code1ItemRaw) return null;
      if (typeof code1ItemRaw === "string") {
        try {
          return JSON.parse(code1ItemRaw);
        } catch {
          return null;
        }
      }
      return code1ItemRaw;
    })();

    const titleText = String(codeItem?.title || code1Item?.标题 || "");
    const titleBlocks = parseTitleBlocks(titleText);
    const titles = (titleBlocks.length > 0 ? titleBlocks : splitByLine(titleText))
      .map(item => item.trim())
      .filter(Boolean);

    const openingHookRaw = code1Item?.opening_text || code1Item?.开头钩子;
    const endingHookRaw = code1Item?.ending_text || code1Item?.结尾钩子;

    const openingHooks = (() => {
      if (typeof openingHookRaw !== "object" || !openingHookRaw) {
        const single = String(openingHookRaw || "").trim();
        return single ? [{ content: single, typeLabel: "" }] : [];
      }

      const extracted = String(openingHookRaw?.extracted || "").trim();
      const created = Array.isArray(openingHookRaw?.created)
        ? openingHookRaw.created.map((item: any) => String(item || "").trim()).filter(Boolean)
        : [];

      return [
        ...(extracted ? [{ content: extracted, typeLabel: "" }] : []),
        ...created.map((content: string) => ({ content, typeLabel: "" })),
        ...readHookCandidates(openingHookRaw),
      ];
    })();

    const endingHooks = (() => {
      if (typeof endingHookRaw !== "object" || !endingHookRaw) {
        const single = String(endingHookRaw || "").trim();
        return single ? [{ content: single, typeLabel: "" }] : [];
      }

      const extracted = String(endingHookRaw?.extracted_result || "").trim();
      const rcs = Array.isArray(endingHookRaw?.rcs)
        ? endingHookRaw.rcs.map((item: any) => String(item || "").trim()).filter(Boolean)
        : [];

      return [
        ...(extracted && extracted !== "无" ? [{ content: extracted, typeLabel: "" }] : []),
        ...rcs.map((content: string) => ({ content, typeLabel: "" })),
        ...readHookCandidates(endingHookRaw),
      ];
    })();

    const hooks: WorkflowHook[] = [
      ...openingHooks.map((item, innerIdx) => ({
        id: `hook-opening-${index}-${innerIdx + 1}`,
        content: item.content,
        hookType: "opening_text" as const,
        ...(item.typeLabel ? { hookTypeLabel: item.typeLabel } : {}),
      })),
      ...endingHooks.map((item, innerIdx) => ({
        id: `hook-ending-${index}-${innerIdx + 1}`,
        content: item.content,
        hookType: "ending_text" as const,
        ...(item.typeLabel ? { hookTypeLabel: item.typeLabel } : {}),
      })),
    ];

    const scriptContent = String(codeItem?.content || "").trim();
    const scripts = scriptContent
      ? [
          {
            id: `script-${index + 1}`,
            title: "二创文案",
            content: scriptContent,
          },
        ]
      : [];

    const result: WorkflowResult = {
      titles,
      hooks,
      scripts,
    };

    return {
      id: `link-${index + 1}`,
      shareLink,
      result,
    };
  });

  return results;
};

export default function ContentPage() {
  const [selectedTitles, setSelectedTitles] = useState<string[]>([]);
  const [selectedHooks, setSelectedHooks] = useState<string[]>([]);
  const [selectedScripts, setSelectedScripts] = useState<string[]>([]);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  /**
   * 并发生成时的进度与失败明细。
   *
   * 串行版本没有这两项也能跑（只有一条在跑）；改成并发后用户需要知道
   * 「现在完成了几条 / 哪几条挂了」，否则 30 条里失败 1 条会被当成整体卡住。
   * 失败明细只做展示，不参与生成判断 —— 重试走 `runWorkflow({ force: false })`，
   * 由 `pickReusableWorkflowGroups` 自动跳过已成功、重新跑缺的。
   */
  const [workflowProgress, setWorkflowProgress] = useState<{ done: number; failed: number; total: number } | null>(null);
  // 失败明细持久化到 sessionStorage：刷新后仍能告诉用户「是哪 2 条、为什么失败」，
  // 而不是只剩一个「补跑未生成（2）」按钮。只作展示，重试仍以「输入 vs 已有结果」为准。
  const [workflowFailures, setWorkflowFailures] = useState<Array<{ id: string; title: string; message: string }>>(() => {
    // 持久化数据不可全信：只接受 id/title/message 都是字符串的条目，避免一条脏数据把整页渲染打崩。
    const stored = loadJson<unknown>("contentWorkflowFailures", []);
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is { id: string; title: string; message: string } => {
      const value = item as Record<string, unknown> | null;
      return Boolean(value)
        && typeof value?.id === "string"
        && typeof value?.title === "string"
        && typeof value?.message === "string";
    });
  });
  /**
   * 哪些选题的创作 Agent 用了「兜底结果」（模型失败/超时/429）。
   *
   * 服务端 `runCreativeAgents` 在单个 Agent 失败时会用规则兜底（文案兜底甚至直接
   * 返回原脚本），payload 结构与正常结果一样 —— 界面上看不出区别。并发 3 条时
   * 同时有 12 个模型调用，429/超时概率比串行高，所以把服务端 Progress 里的
   * `fallbackCount` 收集起来，显式提醒用户「这几条建议重点检查」。
   */
  const [workflowFallbackNotes, setWorkflowFallbackNotes] = useState<Array<{ id: string; title: string; count: number }>>(() => {
    // 兜底提示也要持久化：刷新后「哪些条目是规则兜底出来的」不能凭空消失，
    // 否则用户会把原脚本/模板文案当成模型产物直接发出去。
    const stored = loadJson<unknown>("contentWorkflowFallbackNotes", []);
    if (!Array.isArray(stored)) return [];
    return stored.filter((item): item is { id: string; title: string; count: number } => {
      const value = item as Record<string, unknown> | null;
      return Boolean(value)
        && typeof value?.id === "string"
        && typeof value?.title === "string"
        && typeof value?.count === "number";
    });
  });
  const [streamPreview, setStreamPreview] = useState("");
  const [workflowRawDone, setWorkflowRawDone] = useState(() => sessionStorage.getItem("workflowRawDone") || "");
  const [workflowGroups, setWorkflowGroups] = useState<WorkflowResultGroup[]>(() => {
    const stored = loadJson<unknown>("contentWorkflowGroups", []);
    return Array.isArray(stored) ? (stored as WorkflowResultGroup[]) : [];
  });
  const [activeGroupIndex, setActiveGroupIndex] = useState(() => {
    const raw = Number(sessionStorage.getItem("contentActiveGroupIndex") || 0);
    return Number.isFinite(raw) ? Math.max(0, raw) : 0;
  });
  const [activeScript, setActiveScript] = useState<{ title: string; content: string } | null>(null);

  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [translationPreview, setTranslationPreview] = useState("");
  const [translationItems, setTranslationItems] = useState<TranslationItem[]>([]);
  const [activeTranslationItem, setActiveTranslationItem] = useState<TranslationItem | null>(null);
  const [translationCopyHint, setTranslationCopyHint] = useState<string | null>(null);
  const [taskCompleteVisible, setTaskCompleteVisible] = useState(false);
  const [pendingDraftCount, setPendingDraftCount] = useState(0);
  const [batchExportLoading, setBatchExportLoading] = useState(false);
  const [batchExportMessage, setBatchExportMessage] = useState<string | null>(null);
  const [bitableTargetUrl, setBitableTargetUrl] = useState("");
  const [bitableMode, setBitableMode] = useState<"new" | "existing">("new");
  const [bitableNewName, setBitableNewName] = useState("");
  const [bitableCreateLoading, setBitableCreateLoading] = useState(false);
  const [bitableBindingError, setBitableBindingError] = useState<string | null>(null);

  // ── 按选题保存 / 恢复 / 导出（2026-10-19）──────────────────────────────
  const [savedDrafts, setSavedDrafts] = useState<SavedDraftItem[]>([]);
  const [savedDraftsLoaded, setSavedDraftsLoaded] = useState(false);
  const [savedDraftsError, setSavedDraftsError] = useState("");
  const [saveDraftLoading, setSaveDraftLoading] = useState(false);
  const [editorLoading, setEditorLoading] = useState(false);
  const [saveDraftMessage, setSaveDraftMessage] = useState("");
  const [clearDraftsOpen, setClearDraftsOpen] = useState(false);
  const [clearDraftsLoading, setClearDraftsLoading] = useState(false);
  const [deleteDraftTarget, setDeleteDraftTarget] = useState<SavedDraftItem | null>(null);
  const [deleteDraftLoading, setDeleteDraftLoading] = useState(false);

  /**
   * 已经按哪一条「已保存草稿」还原过当前卡片的勾选。
   *
   * 用 `${group.id}:${draft.id}:${updatedAt}` 做指纹：切题会变 → 还原；
   * 自己刚保存一次也会变（还原成刚保存的结果，等价）；用户保存后继续手工改动不会变，
   * 不会被草稿轮询/刷新把改动冲掉。
   */
  const hydratedSavedDraftRef = useRef("");
  const hydratedSavedGroupRef = useRef("");

  const workflowInFlightRef = useRef(false);
  const workflowRunIdRef = useRef(0);
  const workflowAbortControllerRef = useRef<AbortController | null>(null);
  const autoRunKeyRef = useRef("");
  /**
   * 并发完成后结果会**乱序到达**，而 `workflowGroups` 是按勾选顺序重排的数组。
   * 如果用户已经在看第 2 条并勾了标题，这时第 1 条才完成、数组整体后移，
   * `activeGroupIndex` 会指向另一条 → 选择被清空、卡片「跳走」。
   * 这两个 ref 用来在每次 commit 时把「当前正在看的那条」按 shareLink 重新定位。
   */
  const workflowGroupsRef = useRef(workflowGroups);
  workflowGroupsRef.current = workflowGroups;
  const activeGroupIndexRef = useRef(activeGroupIndex);
  activeGroupIndexRef.current = activeGroupIndex;

  const [rewriteEnabled, setRewriteEnabled] = useState(false);
  const [rewriteLoading, setRewriteLoading] = useState(false);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const [rewritePreview, setRewritePreview] = useState("");
  const [rewriteTarget, setRewriteTarget] = useState<RewritePlatform>("douyin");
  const [rewriteSelection, setRewriteSelection] = useState<string[]>([]);
  const [rewriteResults, setRewriteResults] = useState<Array<{ id: string; original: string; rewritten: string; target: RewritePlatform }>>([]);

  const navigate = useNavigate();

  /**
   * ⚠️ 必须 memo：`loadJson` 每次渲染都会 `JSON.parse` 一遍 sessionStorage，返回新数组。
   * 勾选几十条时 `selectedTopics` 里带着脚本与 rawData（整页可达数百 KB），
   * 不 memo 的话每次渲染都要重新解析一次，并且把下游每个 useMemo 的依赖都打穿
   * （shareLinks / workflowInputs / benchmarkVideos … 全部每帧重算）。
   * 页面生命周期内这两份数据不会被本页改写，所以挂载时读一次即可。
   */
  const selectedTopics = useMemo(() => loadJson<TopicLike[]>("selectedTopics", []), []);
  const contentTasks = useMemo(() => loadJson<any[]>("contentTasks", []), []);
  const activeTask = contentTasks?.[0];
  const bitableBindingKey = useMemo(() => bitableTaskKey(activeTask), [activeTask?._id, activeTask?.customerName]);
  const [cachedBitableBinding, setCachedBitableBinding] = useState<BitableBinding>(() => readBitableBinding(bitableTaskKey(activeTask)));
  const taskTableName = [
    activeTask?.customerName,
    activeTask?.platformName,
    "选题复盘",
  ].filter(Boolean).join(" - ") || "选题复盘";

  useEffect(() => {
    const binding = readBitableBinding(bitableBindingKey);
    setCachedBitableBinding(binding);
    setBitableTargetUrl(binding.targetUrl || binding.bitableUrl || "");
  }, [bitableBindingKey]);

  const shareLinks = useMemo(() => {
    return selectedTopics
      .filter(topic => !isWeChatChannelsTopic(topic))
      .map(getTopicShareLink)
      .map(link => String(link || "").trim())
      .filter(Boolean);
  }, [selectedTopics]);
  // share_links 来源平台：从所选非视频号 topic 推断，含 tiktok 则标 tiktok，否则默认 douyin。
  // 后端据此为 resolveTikHubVideo 选择正确的 TikHub 端点（/tiktok/ 或 /douyin/）。
  const shareLinkPlatform = useMemo(() => {
    const hasTiktok = selectedTopics.some(topic => !isWeChatChannelsTopic(topic) && topic?.platform === "tiktok");
    return hasTiktok ? "tiktok" : "douyin";
  }, [selectedTopics]);

  const wechatTopics = useMemo(() => selectedTopics.filter(isWeChatChannelsTopic), [selectedTopics]);
  const workflowInputs = useMemo(() => [
    ...shareLinks.map(link => ({ id: link, kind: "share_link" as const, link, topic: null as TopicLike | null })),
    ...wechatTopics.map(topic => ({ id: getTopicWorkflowKey(topic), kind: "wechat_topic" as const, link: "", topic })),
  ], [shareLinks, wechatTopics]);
  const workflowInputIds = useMemo(() => workflowInputs.map(item => item.id), [workflowInputs]);
  /**
   * 还缺多少条结果（= 没生成 / 失败 / 本次被取消的都算）。
   *
   * 用它而不是内存里的 `workflowFailures.length` 做按钮文案：致命错误中止整批时，
   * 后面的选题根本没跑、也不会进失败列表；刷新后失败列表更是直接消失。
   * 以「输入条数 - 已有结果条数」为准，按钮说几条就真的补跑几条。
   */
  const missingInputs = useMemo(() => {
    const reusable = pickReusableWorkflowGroups(workflowInputIds, workflowGroups);
    return workflowInputs.filter(input => !reusable.some(group => sameLink(group.shareLink, input.id)));
  }, [workflowInputs, workflowInputIds, workflowGroups]);
  const missingGroupCount = missingInputs.length;
  // 只展示「现在仍缺结果」的失败记录：重试成功后旧记录不能继续挂着吓人。
  const visibleWorkflowFailures = useMemo(
    () => workflowFailures.filter(item => missingInputs.some(input => input.id === item.id)),
    [workflowFailures, missingInputs],
  );
  /** 只保留与当前勾选匹配、且已有结果的兜底提示（刷新/切换任务后不串数据）。 */
  const matchedWorkflowGroups = useMemo(
    () => orderWorkflowGroupsByLinks(workflowInputIds, workflowGroups),
    [workflowInputIds, workflowGroups],
  );
  const visibleFallbackNotes = useMemo(
    () => workflowFallbackNotes.filter(note => (
      workflowInputIds.includes(note.id)
      && matchedWorkflowGroups.some(group => sameLink(group.shareLink, note.id))
    )),
    [workflowFallbackNotes, workflowInputIds, matchedWorkflowGroups],
  );
  /**
   * 「本次进入页面是否已经跑过一轮」的证据。
   *
   * 刷新发生在第一批完成之前时：groups / progress / failures 都是空的，但
   * autoRunKey 已被消费（不会自动重跑）。此时「补跑未生成」按钮必须仍然出现，
   * 否则页面会出现「未生成清单让你点按钮，但按钮不存在」的死路。
   */
  const autoRunKeyForEvidence = sessionStorage.getItem("contentAutoRunKey") || "";
  const autoRunConsumed = Boolean(autoRunKeyForEvidence)
    && sessionStorage.getItem("contentAutoRunConsumedKey") === autoRunKeyForEvidence;
  const hasRunEvidence = workflowProgress !== null
    || matchedWorkflowGroups.length > 0
    || visibleWorkflowFailures.length > 0
    || autoRunConsumed;
  /** 勾选里没有可用链接的非视频号选题：它们不会成为工作流输入，必须如实说明。 */
  const unusableTopics = useMemo(
    () => selectedTopics.filter(topic => !isWeChatChannelsTopic(topic) && !String(getTopicShareLink(topic) || "").trim()),
    [selectedTopics],
  );
  /** 重复链接：两条选题共用一份结果，计数上要说明，否则用户会以为丢了一条。 */
  const duplicateLinkCount = useMemo(() => {
    const seen = new Set<string>();
    let duplicates = 0;
    for (const id of workflowInputIds) {
      if (seen.has(id)) duplicates += 1;
      else seen.add(id);
    }
    return duplicates;
  }, [workflowInputIds]);
  /**
   * 没有「选题页已提取脚本」的条数。
   *
   * 这类条目会在二创请求里**现场** TikHub 解析 + 本地 ffmpeg 抽音频 + ASR
   * （单条约 60~160 秒，是自带脚本条目的 2~4 倍），正是「勾选几十条特别慢」的放大器。
   * 提前显示条数，用户才知道时间花在哪，而不是以为并发没生效。
   */
  const missingScriptCount = useMemo(
    () => selectedTopics.filter(topic => !String(topic?.content?.script || "").trim()).length,
    [selectedTopics],
  );
  /**
   * 「链接 → 库内大类名」。
   *
   * 大类是「今日选题」页打标签时**已经判好**的（`topic.content.categoryName`），
   * 这里只是把它带到后端，好让三秒/结尾钩子 agent 按该大类的配比生成 10 条候选。
   * 🔴 刻意**不在二创页重判一次**：那会多付一次模型调用，还会和已有标签产生两个口径。
   *
   * ⚠️ 键必须是后端能对上的那一个：非视频号走 `share_links`，后端按**链接原文**匹配，
   * 所以这里用 `getTopicShareLink` 的结果；视频号走后端自己解出的媒体链接，
   * 前端拿不到，匹配不上就如实按全局配比降级（不猜、不硬凑）。
   */
  const categoryNamesByLink = useMemo(() => {
    const map: Record<string, string> = {};
    for (const topic of selectedTopics) {
      if (isWeChatChannelsTopic(topic)) continue;
      const link = String(getTopicShareLink(topic) || "").trim();
      const categoryName = String(topic?.content?.categoryName || "").trim();
      if (link && categoryName) map[link] = categoryName;
    }
    return map;
  }, [selectedTopics]);
  const activeGroup = workflowGroups[activeGroupIndex] || null;
  const workflowResult = activeGroup?.result || fallbackResult;
  const benchmarkVideos = useMemo(() => buildBenchmarkVideos(selectedTopics), [selectedTopics]);
  const activeBenchmarkVideos = useMemo(() => {
    const matchedTopics = selectedTopics.filter(topic => sameLink(getTopicWorkflowKey(topic), activeGroup?.shareLink));
    if (matchedTopics.length > 0) return buildBenchmarkVideos(matchedTopics);
    const matched = benchmarkVideos.filter(item => sameLink(item.link, activeGroup?.shareLink));
    return matched.length > 0 ? matched : benchmarkVideos;
  }, [selectedTopics, benchmarkVideos, activeGroup?.shareLink]);

  /** 当前卡片对应的「工作流输入」（链接 / 视频号 key）。 */
  const currentWorkflowInput = useMemo(
    () => workflowInputs.find(input => sameLink(input.id, activeGroup?.shareLink)) || null,
    [workflowInputs, activeGroup?.shareLink],
  );
  /** 当前卡片对应的原始选题（用来拿 topicId / 标题 / 平台）。 */
  const currentTopic = useMemo(() => {
    if (!currentWorkflowInput) return null;
    if (currentWorkflowInput.kind === "wechat_topic") return currentWorkflowInput.topic;
    return selectedTopics.find(topic => sameLink(getTopicShareLink(topic), currentWorkflowInput.id)) || null;
  }, [currentWorkflowInput, selectedTopics]);
  const currentTopicTitle = currentWorkflowInput
    ? getWorkflowInputTitle(currentWorkflowInput, benchmarkVideos)
    : "";

  /** 一条草稿是否对应当前某个工作流输入（链接优先，视频号再按 topicId 兜底）。 */
  const draftMatchesWorkflowInput = (draft: SavedDraftItem, input: (typeof workflowInputs)[number]) => {
    if (!draft?.topic) return false;
    if (draft.topic.shareLink && sameLink(draft.topic.shareLink, input.id)) return true;
    const inputTopicId = String(input.kind === "wechat_topic" ? input.topic?.id || "" : "");
    if (inputTopicId && draft.topic.id && sameLink(draft.topic.id, inputTopicId)) return true;
    if (input.kind === "share_link") {
      const topic = selectedTopics.find(item => sameLink(getTopicShareLink(item), input.id));
      if (topic?.id && draft.topic.id && sameLink(String(topic.id), draft.topic.id)) return true;
    }
    return false;
  };
  const findSavedDraftForGroup = (group: WorkflowResultGroup | null) => {
    if (!group) return null;
    const input = workflowInputs.find(item => sameLink(item.id, group.shareLink));
    if (!input) return null;
    return savedDrafts.find(draft => draftMatchesWorkflowInput(draft, input)) || null;
  };
  const savedDraftForCurrentGroup = findSavedDraftForGroup(activeGroup);
  /** 当前这批勾选里、已经有保存记录的草稿（导出列表与「已保存 N 条」都用它）。 */
  const savedDraftsForCurrentInputs = useMemo(
    () => savedDrafts.filter(draft => workflowInputs.some(input => draftMatchesWorkflowInput(draft, input))),
    [savedDrafts, workflowInputs, selectedTopics],
  );

  const toggleSelection = (value: string, list: string[], setList: (v: string[]) => void) => {
    setList(list.includes(value) ? list.filter(item => item !== value) : [...list, value]);
  };

  const funnelStatus = useMemo(() => {
    return {
      titleCount: selectedTitles.length,
      hookCount: selectedHooks.length,
      scriptCount: selectedScripts.length,
    };
  }, [selectedTitles, selectedHooks, selectedScripts]);

  useEffect(() => {
    if (!translationEnabled) {
      setTranslationError(null);
      setTranslationPreview("");
      setTranslationItems([]);
    }
  }, [translationEnabled]);

  useEffect(() => {
    if (!rewriteEnabled) {
      setRewriteError(null);
      setRewritePreview("");
      setRewriteSelection([]);
      setRewriteResults([]);
    }
  }, [rewriteEnabled]);

  useEffect(() => {
    return () => {
      workflowAbortControllerRef.current?.abort();
      workflowAbortControllerRef.current = null;
      workflowInFlightRef.current = false;
    };
  }, []);

  /**
   * 切换卡片时：优先还原「这条选题上次保存的勾选」，没有保存记录才清空。
   *
   * 这是「保存过的记录不要被覆盖」的核心：用户切到别的选题再切回来，之前勾的
   * 标题 / 3 秒 / 结尾钩子 / 二创文案（以及改写、翻译结果）都还在。
   * ⚠️ 等 `savedDraftsLoaded` 后再决定要不要清空 —— 否则草稿列表还没回来就先清空，
   *    会出现「先闪空、再恢复」的观感。
   */
  useEffect(() => {
    if (!activeGroup) {
      hydratedSavedDraftRef.current = "";
      setSelectedTitles([]);
      setSelectedHooks([]);
      setSelectedScripts([]);
      setTranslationItems([]);
      setRewriteSelection([]);
      setRewriteResults([]);
      return;
    }

    const draft = findSavedDraftForGroup(activeGroup);
    const switchedGroup = hydratedSavedGroupRef.current !== activeGroup.id;
    hydratedSavedGroupRef.current = activeGroup.id;
    if (!draft) {
      if (!savedDraftsLoaded) return;
      const key = `${activeGroup.id}:none`;
      if (hydratedSavedDraftRef.current === key) return;
      hydratedSavedDraftRef.current = key;
      setSelectedTitles([]);
      setSelectedHooks([]);
      setSelectedScripts([]);
      setTranslationItems([]);
      setRewriteSelection([]);
      setRewriteResults([]);
      setSaveDraftMessage("");
      return;
    }

    const key = `${activeGroup.id}:${draft.id}:${draft.updatedAt || draft.createdAt || ""}`;
    if (hydratedSavedDraftRef.current === key) return;
    hydratedSavedDraftRef.current = key;

    const selection = draft.selection || {};
    // 只还原「当前生成结果里仍然存在」的条目：重新生成后 id/文本可能已经变了，
    // 硬套旧值会让界面显示成已勾选、实际却找不到对应候选。
    const restoredTitles = (selection.selectedTitles || []).filter(item => workflowResult.titles.includes(item));
    const restoredHooks = (selection.selectedHooks || []).filter(id => workflowResult.hooks.some(hook => hook.id === id));
    const restoredScripts = (selection.selectedScripts || []).filter(id => workflowResult.scripts.some(script => script.id === id));
    const restoredRewriteSelection = (selection.rewriteSelection || []).filter(id => workflowResult.scripts.some(script => script.id === id));

    setSelectedTitles(restoredTitles);
    setSelectedHooks(restoredHooks);
    setSelectedScripts(restoredScripts);
    setRewriteSelection(restoredRewriteSelection);
    setRewriteResults(Array.isArray(selection.rewriteResults) ? selection.rewriteResults as any : []);
    setTranslationItems(Array.isArray(selection.translationItems) ? selection.translationItems as any : []);
    setRewriteEnabled(Boolean(selection.rewriteEnabled));
    setTranslationEnabled(Boolean(selection.translationEnabled));
    if (selection.rewriteTarget) setRewriteTarget(selection.rewriteTarget);

    const savedSelectionCount = (selection.selectedTitles?.length || 0)
      + (selection.selectedHooks?.length || 0)
      + (selection.selectedScripts?.length || 0);
    const restoredCount = restoredTitles.length + restoredHooks.length + restoredScripts.length;
    if (savedSelectionCount > 0 && restoredCount === 0) {
      setSaveDraftMessage("已保存记录与当前生成内容不一致（可能重新生成过），请重新勾选后再保存。");
    } else if (switchedGroup) {
      // 只在「切到另一条选题」时提示载入；刚保存后 updatedAt 变化会再次触发放映，
      // 那时不能覆盖「已保存」的提示文案。
      const savedAt = new Date(draft.updatedAt || draft.createdAt || Date.now());
      setSaveDraftMessage(`已载入 ${savedAt.toLocaleString("zh-CN", { hour12: false })} 保存的记录`);
    }
  }, [activeGroup?.id, workflowResult, savedDrafts, savedDraftsLoaded]);

  useEffect(() => {
    safeSessionSet("contentActiveGroupIndex", String(activeGroupIndex));
  }, [activeGroupIndex]);

  /** 已保存记录的列表地址（带上客户/任务范围；服务端再按登录用户隔离）。 */
  const draftListUrl = () => {
    const params = new URLSearchParams();
    const customerId = sessionStorage.getItem("contentCustomerId") || "";
    const taskId = String(activeTask?._id || "");
    if (customerId) params.set("customerId", customerId);
    if (taskId) params.set("taskId", taskId);
    const query = params.toString();
    return apiUrl(`/api/final-drafts${query ? `?${query}` : ""}`);
  };

  /** 读取「已保存记录」——按 客户 + 任务 收窄；服务端再按登录用户隔离。 */
  const loadSavedDrafts = async () => {
    try {
      const response = await fetchWithRetry(draftListUrl());
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || `读取已保存记录失败（HTTP ${response.status}）`);
      }
      const items = Array.isArray(data?.items) ? data.items.filter(Boolean) : [];
      setSavedDrafts(items as SavedDraftItem[]);
      setPendingDraftCount(items.length);
      setSavedDraftsError("");
    } catch (error) {
      // 服务端读不到时仍保留浏览器缓存里的「待导出」计数，不让整个页面报错。
      setPendingDraftCount(readCachedFinalDrafts().length);
      setSavedDraftsError(error instanceof Error ? error.message : "读取已保存记录失败");
    } finally {
      setSavedDraftsLoaded(true);
    }
  };

  useEffect(() => {
    void loadSavedDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时读一次；保存/删除后手动刷新
  }, []);

  const parseTranslationPayload = (
    payloadText: string,
    selectedPayload: { titles: string[]; hooks: string[]; scripts: string[] },
  ): TranslationItem[] => {
    const text = String(payloadText || "").trim();
    if (!text) return [];

    const startIdx = text.indexOf("{");
    const endIdx = text.lastIndexOf("}");
    const jsonText = startIdx >= 0 && endIdx > startIdx ? text.slice(startIdx, endIdx + 1) : text;

    let obj: any = null;
    try {
      obj = JSON.parse(jsonText);
    } catch {
      const fallbackLines = splitByLine(text);
      const fallbackTranslated = fallbackLines.join("\n").trim();
      const fallbackOriginal = [
        ...selectedPayload.titles,
        ...selectedPayload.hooks,
        ...selectedPayload.scripts,
      ].join("\n\n").trim();

      if (!fallbackTranslated) return [];
      return [
        {
          id: "translation-1",
          sourceType: "script",
          original: fallbackOriginal || "（未识别到原文）",
          translated: fallbackTranslated,
          zh: fallbackOriginal || "（未识别到原文）",
          en: fallbackTranslated,
        },
      ];
    }

    const list: TranslationItem[] = [];

    const appendIfValid = (
      original: string,
      translated: string,
      sourceType: TranslationItem["sourceType"],
    ) => {
      const originText = String(original || "").trim();
      const translatedText = String(translated || "").trim();
      if (!originText || !translatedText) return;
      list.push({
        id: `${sourceType}-${list.length + 1}`,
        original: originText,
        translated: translatedText,
        zh: originText,
        en: translatedText,
        sourceType,
      });
    };

    if (Array.isArray(obj?.translations)) {
      obj.translations.forEach((item: any) => {
        appendIfValid(
          item?.original || item?.source || item?.zh || item?.cn,
          item?.translated || item?.target || item?.en || item?.english,
          item?.sourceType || "script",
        );
      });
    }

    if (Array.isArray(obj?.data)) {
      obj.data.forEach((item: any) => {
        appendIfValid(
          item?.original || item?.source_text || item?.zh || item?.cn,
          item?.translated || item?.target_text || item?.en || item?.english,
          item?.sourceType || "script",
        );
      });
    }

    if (list.length === 0) {
      const translatedText = String(
        obj?.translated_text || obj?.translated || obj?.result || obj?.en || obj?.english || "",
      ).trim();
      const originalTextFromPayload = [
        ...selectedPayload.titles,
        ...selectedPayload.hooks,
        ...selectedPayload.scripts,
      ].join("\n\n").trim();
      const originalText = String(obj?.original_text || originalTextFromPayload || "（未识别到原文）").trim();

      if (translatedText) {
        appendIfValid(originalText, translatedText, "script");
      } else {
        const rawOutput = String(obj?.output || text || "").trim();
        const match = rawOutput.match(/"translated_text"\s*:\s*"([\s\S]*?)"/);
        const extracted = match?.[1]
          ? match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim()
          : "";
        if (extracted) {
          appendIfValid(originalText, extracted, "script");
        }
      }
    }

    return list;
  };

  const runTranslationWorkflow = async () => {
    if (!translationEnabled) return;

    const selectedTitleBlocks = workflowResult.titles.filter(item => selectedTitles.includes(item));
    const selectedHookObjects = workflowResult.hooks.filter(item => selectedHooks.includes(item.id));
    const selectedScriptObjects = workflowResult.scripts.filter(item => selectedScripts.includes(item.id));

    const payloadForTranslation = {
      titles: selectedTitleBlocks.map(extractTitleLabel),
      hooks: selectedHookObjects.map(item => item.content),
      scripts: selectedScriptObjects.map(item => item.content),
    };

    const hasAnySelected =
      payloadForTranslation.titles.length > 0 ||
      payloadForTranslation.hooks.length > 0 ||
      payloadForTranslation.scripts.length > 0;

    if (!hasAnySelected) {
      setTranslationError("请先在标题 / 3秒留存 / 二创文案中至少勾选一项，再执行翻译。");
      return;
    }

    setTranslationLoading(true);
    setTranslationError(null);
    setTranslationPreview("");
    setTranslationItems([]);

    try {
      const response = await fetchWithRetry(apiUrl("/api/agent/translation"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          payload: payloadForTranslation,
        }),
      });

      if (!response.ok) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const payloadText = JSON.stringify(data, null, 2);
      setTranslationPreview(payloadText);
      const parsed = parseTranslationPayload(payloadText, payloadForTranslation)
        .map((item) => {
          const translatedOnly = String(item.translated || item.en || "").trim();
          return {
            ...item,
            translated: translatedOnly,
            en: translatedOnly,
          };
        })
        .filter((item) => String(item.translated || "").trim().length > 0);
      setTranslationItems(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "翻译工作流执行失败";
      setTranslationError(message);
    } finally {
      setTranslationLoading(false);
    }
  };

  const runRewriteWorkflow = async () => {
    if (!rewriteEnabled) return;

    const candidateScripts = workflowResult.scripts;
    const selectedRewriteScripts = candidateScripts.filter(item => rewriteSelection.includes(item.id));

    if (selectedRewriteScripts.length === 0) {
      setRewriteError("请在文案风格转写板块至少勾选一条文案后再执行转写。");
      return;
    }

    setRewriteLoading(true);
    setRewriteError(null);
    setRewritePreview("");
    setRewriteResults([]);

    try {
      const inputPayload = selectedRewriteScripts.map(item => ({ id: item.id, text: item.content }));

      const response = await fetchWithRetry(apiUrl("/api/agent/rewrite"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetPlatform: rewriteTarget,
          scripts: inputPayload,
        }),
      });

      if (!response.ok) {
        const t = await response.text();
        throw new Error(t || `HTTP ${response.status}`);
      }

      const parsed = await response.json();
      const answerText = JSON.stringify(parsed, null, 2);
      setRewritePreview(answerText);

      if (Array.isArray(parsed?.results)) {
        const mapped = parsed.results
          .map((item: any, idx: number) => {
            const id = String(item?.id || selectedRewriteScripts[idx]?.id || `rw-${idx + 1}`);
            const rewritten = String(item?.rewritten || item?.content || "").trim();
            const original = selectedRewriteScripts.find(s => s.id === id)?.content || selectedRewriteScripts[idx]?.content || "";
            if (!rewritten) return null;
            return { id, original, rewritten, target: rewriteTarget };
          })
          .filter(Boolean) as Array<{ id: string; original: string; rewritten: string; target: RewritePlatform }>;

        setRewriteResults(mapped);
      } else if (answerText) {
        const first = selectedRewriteScripts[0];
        setRewriteResults([
          {
            id: first?.id || "rw-1",
            original: first?.content || "",
            rewritten: answerText,
            target: rewriteTarget,
          },
        ]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "转写对话流执行失败";
      setRewriteError(message);
    } finally {
      setRewriteLoading(false);
    }
  };

  const clearAllPendingDrafts = async () => {
    try {
      const resp = await fetchWithRetry(apiUrl("/api/final-drafts"), { method: "DELETE" });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `清空待导出文案失败（HTTP ${resp.status}）`);
      }
    } finally {
      clearCachedFinalDrafts();
    }
  };

  const readPendingDraftItems = async (allowCache = true) => {
    try {
      const draftResp = await fetchWithRetry(draftListUrl());
      const draftData = await draftResp.json();
      if (!draftResp.ok || draftData?.success === false) throw new Error(draftData?.error || "读取保存记录失败");
      const list = Array.isArray(draftData?.items) ? draftData.items : [];
      if (list.length > 0 || !allowCache) return filterExportDrafts(list, {
        customerId: sessionStorage.getItem("contentCustomerId") || "",
        taskId: String(activeTask?._id || ""),
        topics: selectedTopics,
      });
    } catch (error) {
      if (!allowCache) throw error;
      // fall back to browser cache below
    }
    return filterExportDrafts(readCachedFinalDrafts(), {
      customerId: sessionStorage.getItem("contentCustomerId") || "",
      taskId: String(activeTask?._id || ""),
      topics: selectedTopics,
    });
  };

  const buildCombinedDraft = (items: any[]) => ({
    titleDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.titleDraft || "")}`).join("\n\n"),
    hookDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.hookDraft || "")}`).join("\n\n"),
    scriptDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.scriptDraft || "")}`).join("\n\n"),
    rewriteDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.rewriteDraft || "")}`).join("\n\n"),
    translationDraft: items.map((item, idx) => `【选题 ${idx + 1}】\n${String(item?.translationDraft || "")}`).join("\n\n"),
    benchmarkVideos: items.flatMap(item => Array.isArray(item?.benchmarkVideos) ? item.benchmarkVideos : []),
    taskInfo: items.find(item => item?.taskInfo)?.taskInfo || {
      id: String(activeTask?._id || ""),
      customerName: String(activeTask?.customerName || ""),
      ownerName: String(activeTask?.ownerName || ""),
      platformName: String(activeTask?.platformName || ""),
      contentDirection: String(activeTask?.contentDirection || ""),
    },
  });

  // 解析飞书多维表格 URL：取出 appToken / tableId（与后端 parseFeishuBitableUrl 口径一致）
  const parseBitableUrl = (value: string): { appToken?: string; tableId?: string } => {
    const text = String(value || "").trim();
    if (!text) return {};
    try {
      const parsed = new URL(text);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const baseIndex = parts.findIndex(part => part === "base");
      if (baseIndex >= 0 && parts[baseIndex + 1]) {
        return {
          appToken: parts[baseIndex + 1],
          tableId: parsed.searchParams.get("table") || undefined,
        };
      }
    } catch {
      // fall through
    }
    const tokenMatch = text.match(/\b(app[a-zA-Z0-9]{8,})\b/);
    return tokenMatch ? { appToken: tokenMatch[1] } : {};
  };

  // 创建新多维表格：立即调飞书 API 建表，拿到 URL 完成绑定
  const bindNewBitable = async () => {
    setBitableCreateLoading(true);
    setBitableBindingError(null);
    try {
      const taskInfo = activeTask ? {
        id: String(activeTask._id || ""),
        customerName: String(activeTask.customerName || ""),
        ownerName: String(activeTask.ownerName || ""),
        platformName: String(activeTask.platformName || ""),
        contentDirection: String(activeTask.contentDirection || ""),
      } : null;
      const name = bitableNewName.trim() || undefined;
      const response = await fetchWithRetry(apiUrl("/api/export/bitable/create"), {
        method: "POST",
        retries: 0,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, taskInfo }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `创建多维表格失败（HTTP ${response.status}）`);
      }
      const binding: BitableBinding = {
        targetUrl: "",
        appToken: String(data?.appToken || ""),
        tableId: String(data?.tableId || ""),
        tableName: String(data?.tableName || taskTableName),
        bitableUrl: String(data?.bitableUrl || ""),
      };
      writeBitableBinding(bitableBindingKey, binding);
      setCachedBitableBinding(binding);
      setBatchExportMessage(null);
      if (binding.bitableUrl) window.open(binding.bitableUrl, "_blank", "noopener,noreferrer");
    } catch (error) {
      setBitableBindingError(error instanceof Error ? error.message : "创建多维表格失败");
    } finally {
      setBitableCreateLoading(false);
    }
  };

  // 绑定已有多维表格：解析 URL 取 appToken/tableId，写回 binding（首次写入时后端会在该 app 下自动建表）
  const bindExistingBitable = () => {
    setBitableBindingError(null);
    const raw = bitableTargetUrl.trim();
    const parsed = parseBitableUrl(raw);
    if (!parsed.appToken) {
      setBitableBindingError("请粘贴合法的飞书多维表格 URL，需包含 /base/<token> 路径。");
      return;
    }
    const binding: BitableBinding = {
      targetUrl: raw,
      appToken: parsed.appToken,
      tableId: parsed.tableId || "",
      tableName: cachedBitableBinding.tableName || taskTableName,
      bitableUrl: raw,
    };
    writeBitableBinding(bitableBindingKey, binding);
    setCachedBitableBinding(binding);
    setBatchExportMessage(null);
  };

  /**
   * 导出全部「已保存记录」——**不经过发布仓**也能用（用户 2026-10-19 的要求）。
   *
   * 与服务端导出路由的契约：
   *   · `{ documentName, items }` → 合并成一篇文章；每条一个「选题 N」标题；
   *   · `{ items, taskInfo, targetUrl, feishuBitable }` → 一张多维表格里多条记录。
   *
   * ⚠️ 导出**不再自动清空记录**：用户明确要求记录一直保留；清空改为单独的显式操作。
   */
  const exportAllPendingDrafts = async (format: "feishu" | "bitable", currentOnly = false) => {
    setBatchExportLoading(true);
    setBatchExportMessage(null);

    try {
      const currentPayload = currentOnly ? buildContentDraftPayload() : null;
      const currentSaved = currentPayload && savedDraftForCurrentGroup
        && sameDraftSelection(savedDraftForCurrentGroup.selection, currentPayload.selection)
        ? savedDraftForCurrentGroup : null;
      if (currentOnly && !currentSaved && !await saveCurrentDraft()) return;
      const items = currentOnly
        ? [pickDraftExportBlock(currentSaved || currentPayload!, "content")]
        : await readPendingDraftItems();
      if (items.length === 0) throw new Error("暂无可导出的已保存文案：请先在本页点「保存本条文案」");

      if (format === "feishu") {
        const response = await fetchWithRetry(apiUrl("/api/export/feishu"), {
          method: "POST",
          retries: 0,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            documentName: currentOnly
              ? `${taskTableName} - 二创 - ${compactTopicLabel(currentTopicTitle, 40)}`
              : `${taskTableName} - ${new Date().toISOString().slice(0, 10)}`,
            items,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || `写入飞书文档失败（HTTP ${response.status}）`);
        }
        const documentUrl = String(data?.documentUrl || "");
        if (documentUrl) window.open(documentUrl, "_blank", "noopener,noreferrer");
        setBatchExportMessage(`已写入飞书文档（${items.length} 条记录，记录已保留）`);
      } else if (format === "bitable") {
        if (!cachedBitableBinding.appToken && !cachedBitableBinding.targetUrl && !cachedBitableBinding.bitableUrl) {
          throw new Error("请先创建一份新的多维表格，或绑定已有的多维表格 URL，再写入数据。");
        }
        const binding: BitableBinding = {
          targetUrl: cachedBitableBinding.targetUrl || cachedBitableBinding.bitableUrl || "",
          appToken: cachedBitableBinding.appToken || "",
          tableId: cachedBitableBinding.tableId || "",
          tableName: cachedBitableBinding.tableName || taskTableName,
          bitableUrl: cachedBitableBinding.bitableUrl || "",
        };
        const response = await fetchWithRetry(apiUrl("/api/export/bitable"), {
          method: "POST",
          retries: 0,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items,
            taskInfo: {
              id: String(activeTask?._id || ""),
              customerName: String(activeTask?.customerName || ""),
              ownerName: String(activeTask?.ownerName || ""),
              platformName: String(activeTask?.platformName || ""),
            },
            targetUrl: binding.targetUrl,
            feishuBitable: binding,
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || `写入飞书多维表格失败（HTTP ${response.status}）`);
        }
        const nextBinding: BitableBinding = {
          targetUrl: binding.targetUrl,
          appToken: String(data?.appToken || binding.appToken || ""),
          tableId: String(data?.tableId || binding.tableId || ""),
          tableName: String(data?.tableName || binding.tableName || taskTableName),
          bitableUrl: String(data?.bitableUrl || binding.bitableUrl || ""),
        };
        writeBitableBinding(bitableBindingKey, nextBinding);
        setCachedBitableBinding(nextBinding);
        setBitableTargetUrl(nextBinding.targetUrl || nextBinding.bitableUrl || "");
        if (nextBinding.bitableUrl) window.open(nextBinding.bitableUrl, "_blank", "noopener,noreferrer");
        setBatchExportMessage(`已写入飞书多维表格（${items.length} 条记录，记录已保留）`);
      }

      await loadSavedDrafts();
    } catch (error) {
      setBatchExportMessage(error instanceof Error ? error.message : "批量导出失败");
    } finally {
      setBatchExportLoading(false);
    }
  };

  /**
   * 组装交给最终编辑页的负载（三块勾选 + 改写/翻译结果 + 任务信息）。
   *
   * ⚠️ 这份底稿必须在**离开内容生成页时**写好：最终编辑页只读 `finalDraftPayload`，
   *    而发布仓那一步是在已有 payload 上**追加**封面与标签，不是重建 ——
   *    底稿缺失时「内容生成页 → 发布仓 → 最终编辑页」会拿到空负载。
   */
  const buildFinalDraftPayload = () => {
    const selectedTitleBlocks = workflowResult.titles.filter(item => selectedTitles.includes(item));
    const selectedHookObjects = workflowResult.hooks.filter(item => selectedHooks.includes(item.id));
    const selectedScriptObjects = workflowResult.scripts.filter(item => selectedScripts.includes(item.id));

    return {
      selectedTitles: selectedTitleBlocks.map(item => ({
        title: extractTitleLabel(item),
        detail: splitByLine(item).slice(1).join("\n"),
        raw: item,
      })),
      selectedHooks: selectedHookObjects,
      selectedScripts: selectedScriptObjects,
      rewriteResults,
      translationItems,
      benchmarkVideos: activeBenchmarkVideos,
      taskInfo: activeTask ? {
        id: String(activeTask._id || ""),
        customerName: String(activeTask.customerName || ""),
        ownerName: String(activeTask.ownerName || ""),
        platformName: String(activeTask.platformName || ""),
        contentDirection: String(activeTask.contentDirection || ""),
      } : null,
      createdAt: Date.now(),
      sourceGroupId: activeGroup?.id || null,
      sourceGroupIndex: activeGroupIndex,
      totalGroups: workflowGroups.length,
      // 最终编辑页保存时也要带身份与勾选：否则它写出的草稿没有 topicId，
      // 内容页再保存一次就会变成两条重复记录（内容页 -> 发布仓 -> 最终编辑页 是常规路径）。
      topic: currentTopic || currentWorkflowInput ? {
        id: String(currentTopic?.id || currentWorkflowInput?.id || ""),
        title: currentTopicTitle,
        shareLink: currentWorkflowInput?.id || "",
        platform: String(currentTopic?.platform || shareLinkPlatform),
      } : null,
      customerId: sessionStorage.getItem("contentCustomerId") || "",
      taskId: String(activeTask?._id || ""),
      selection: {
        selectedTitles: selectedTitleBlocks,
        selectedHooks: selectedHooks,
        selectedScripts: selectedScripts,
        rewriteSelection,
        rewriteResults,
        translationItems,
        rewriteEnabled,
        translationEnabled,
        rewriteTarget,
        sourceGroupId: activeGroup?.id || "",
        sourceGroupIndex: activeGroupIndex,
        totalGroups: workflowGroups.length,
      },
    };
  };

  /**
   * 组装「保存到服务端」的当前选题草稿。
   *
   * 与 `buildFinalDraftPayload`（交给最终编辑页的 sessionStorage 交接稿）不同：
   * 这份要带 owner/customer/task/topic 身份与勾选快照，服务端按
   * `owner|customer|task|topic` upsert —— 同一选题再保存是更新，不同选题不会互相覆盖。
   */
  const buildContentDraftPayload = () => {
    const selectedTitleBlocks = workflowResult.titles.filter(item => selectedTitles.includes(item));
    const selectedHookObjects = workflowResult.hooks.filter(item => selectedHooks.includes(item.id));
    const selectedScriptObjects = workflowResult.scripts.filter(item => selectedScripts.includes(item.id));

    const openingHooks = selectedHookObjects.filter(item => item.hookType !== "ending_text");
    const endingHooks = selectedHookObjects.filter(item => item.hookType === "ending_text");

    const titleDraft = selectedTitleBlocks.map((item, index) => {
      const display = formatTitleDisplay(item);
      return `${index + 1}. ${display.titleLabel}${display.detailLines.length ? `\n${display.detailLines.join("\n")}` : ""}`;
    }).join("\n\n");
    const hookDraft = openingHooks.map((item, index) => `${index + 1}. ${item.content}`).join("\n\n");
    const endingHookDraft = endingHooks.map((item, index) => `${index + 1}. ${item.content}`).join("\n\n");
    const scriptDraft = selectedScriptObjects.map((item, index) => `【文案 ${index + 1}】\n${item.content}`).join("\n\n");
    const rewriteDraft = rewriteResults.map((item, index) => `【${index + 1} | ${item.target}】\n${item.rewritten}`).join("\n\n");
    const translationDraft = translationItems
      .map((item, index) => `【${index + 1} | ${item.sourceType}】\nZH: ${item.zh}\nEN: ${item.en}`)
      .join("\n\n");

    return {
      topic: {
        id: String(currentTopic?.id || currentWorkflowInput?.id || ""),
        title: currentTopicTitle,
        shareLink: currentWorkflowInput?.id || "",
        platform: String(currentTopic?.platform || shareLinkPlatform),
      },
      customerId: sessionStorage.getItem("contentCustomerId") || "",
      taskId: String(activeTask?._id || ""),
      titleDraft,
      hookDraft,
      endingHookDraft,
      scriptDraft,
      rewriteDraft,
      translationDraft,
      benchmarkVideos: activeBenchmarkVideos,
      taskInfo: activeTask ? {
        id: String(activeTask._id || ""),
        customerName: String(activeTask.customerName || ""),
        ownerName: String(activeTask.ownerName || ""),
        platformName: String(activeTask.platformName || ""),
        contentDirection: String(activeTask.contentDirection || ""),
      } : null,
      // 发布仓字段不在这里覆盖：服务端 upsert 时若本次没带 publishWarehouse 会保留旧值，
      // 所以「内容页保存」不会把发布仓挑好的封面/文案/标签冲掉。
      publishWarehouse: null,
      selection: {
        selectedTitles: selectedTitleBlocks,
        selectedHooks,
        selectedScripts,
        rewriteSelection,
        rewriteResults,
        translationItems,
        rewriteEnabled,
        translationEnabled,
        rewriteTarget,
        sourceGroupId: activeGroup?.id || "",
        sourceGroupIndex: activeGroupIndex,
        totalGroups: workflowGroups.length,
      },
    };
  };

  const hasCurrentSelection = () => (
    workflowResult.titles.some(item => selectedTitles.includes(item))
    || workflowResult.hooks.some(item => selectedHooks.includes(item.id))
    || workflowResult.scripts.some(item => selectedScripts.includes(item.id))
  );

  /** 保存当前卡片（服务端持久化；同一选题再保存=更新）。不改变当前浏览位置。 */
  const saveCurrentDraft = async () => {
    if (!activeGroup) {
      setSaveDraftMessage("请先选择一条已有生成结果的选题。");
      return false;
    }
    if (!hasCurrentSelection()) {
      setSaveDraftMessage("请先在标题 / 3 秒留存 / 结尾钩子 / 二创文案中至少勾选一项，再保存。");
      return false;
    }
    setSaveDraftLoading(true);
    setSaveDraftMessage("");
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildContentDraftPayload()),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || `保存失败（HTTP ${response.status}）`);
      }
      await loadSavedDrafts();
      setSaveDraftMessage(`本条文案已保存（${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`);
      return true;
    } catch (error) {
      setSaveDraftMessage(error instanceof Error ? error.message : "保存失败");
      return false;
    } finally {
      setSaveDraftLoading(false);
    }
  };

  const jumpToSavedDraft = (draft: SavedDraftItem) => {
    const shareLink = String(draft?.topic?.shareLink || "").trim();
    const index = shareLink
      ? workflowGroups.findIndex(group => sameLink(group.shareLink, shareLink))
      : -1;
    if (index < 0) {
      setSaveDraftMessage("这条记录对应的选题不在当前批次里（可能换了任务/客户），无法跳转。");
      return;
    }
    setActiveGroupIndex(index);
    safeSessionSet("contentActiveGroupIndex", String(index));
  };

  const deleteSavedDraft = async () => {
    if (!deleteDraftTarget) return;
    setDeleteDraftLoading(true);
    try {
      const response = await fetchWithRetry(apiUrl(`/api/final-drafts/${encodeURIComponent(deleteDraftTarget.id)}`), { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || `删除失败（HTTP ${response.status}）`);
      }
      await loadSavedDrafts();
      setSaveDraftMessage("已删除这条保存记录。");
      setDeleteDraftTarget(null);
    } catch (error) {
      setSaveDraftMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setDeleteDraftLoading(false);
    }
  };

  const clearSavedDrafts = async () => {
    setClearDraftsLoading(true);
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"), { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || `清空失败（HTTP ${response.status}）`);
      }
      await loadSavedDrafts();
      setSaveDraftMessage("已清空本任务下的保存记录。");
      setClearDraftsOpen(false);
    } catch (error) {
      setSaveDraftMessage(error instanceof Error ? error.message : "清空失败");
    } finally {
      setClearDraftsLoading(false);
    }
  };

  /**
   * 交接给发布仓（2026-09-21 第七轮）。
   *
   * 发布仓要用的东西**都在 sessionStorage 里**（`selectedTopics` / `contentWorkflowGroups`
   * / `contentCustomerId`），由上面的流程写下，所以这里只需导航。
   * ⚠️ 但要**先把当前这批的分组结果落盘**：用户在内容生成页可能刚点了「重新生成」，
   *    `workflowGroups` 还只在内存里，不落盘的话发布仓读不到 3.2 要复用的标题与 3s。
   */
  const goToPublishWarehouse = async () => {
    // 先持久化当前选择，返回内容页时才有可恢复的勾选。
    const current = buildContentDraftPayload();
    const unchanged = savedDraftForCurrentGroup && sameDraftSelection(savedDraftForCurrentGroup.selection, current.selection);
    if (hasCurrentSelection() && !unchanged && !await saveCurrentDraft()) return;
    try {
      sessionStorage.setItem("contentWorkflowGroups", JSON.stringify(workflowGroups));
      // 发布仓会在最终编辑页的负载上追加封面与标签，所以底稿由这里落盘（见 buildFinalDraftPayload）。
      const payload = unchanged
        ? editorPayloadFromDraft(savedDraftForCurrentGroup!, { id: activeGroup?.id || "", index: activeGroupIndex, total: workflowGroups.length })
        : buildFinalDraftPayload();
      sessionStorage.setItem("finalDraftPayload", JSON.stringify(payload));
    } catch {
      setSaveDraftMessage("交接内容未能写入浏览器，已留在当前页。请重试；已保存的文案仍会保留。");
      return;
    }
    navigate("/publish-warehouse");
  };

  const goToFinalEditor = async () => {
    setEditorLoading(true);
    setSaveDraftMessage("");
    try {
      if (!activeGroup || !currentTopic) throw new Error("请先选择一条已有生成结果的选题。");
      const current = buildContentDraftPayload();
      let draft = (await readPendingDraftItems(false)).find(item => sameDraftTopic(item, currentTopic));
      if (hasCurrentSelection() && !sameDraftSelection(draft?.selection, current.selection)) {
        if (!await saveCurrentDraft()) return;
        draft = (await readPendingDraftItems(false)).find(item => sameDraftTopic(item, currentTopic));
      }
      if (!draft || !hasDraftExportContent(draft, "content")) {
        throw new Error("请先勾选当前选题的文案，再进入最终文案编辑页。");
      }
      const customerId = sessionStorage.getItem("contentCustomerId") || "";
      const [selections, library] = customerId
        ? await Promise.all([listPublishSelections(customerId), getAccountTags(customerId)])
        : [[], null];
      const merged = withCurrentPublishSelection(draft, selections.find(item => item.topicId === draft.topic?.id), library?.confirmed || {});
      sessionStorage.setItem("finalDraftPayload", JSON.stringify(editorPayloadFromDraft(merged, {
        id: activeGroup.id, index: activeGroupIndex, total: workflowGroups.length,
      })));
      navigate("/final-editor");
    } catch (error) {
      setSaveDraftMessage(`暂不能进入最终编辑：${error instanceof Error ? error.message : "读取或交接保存失败，请重试"}`);
    } finally {
      setEditorLoading(false);
    }
  };

  // 结束本次任务：解绑当前任务的多维表格（仅清前端 binding，飞书侧表格保留）
  const unbindBitableBinding = () => {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(bitableBindingKey);
      }
    } catch {
      // 忽略 localStorage 不可用
    }
    setCachedBitableBinding({});
    setBitableTargetUrl("");
  };

  const handleConfirmComplete = () => {
    try {
      unbindBitableBinding();
    } catch {
      // 即便解绑异常，也不阻断结束任务
    }
    setTaskCompleteVisible(true);
    setTimeout(() => {
      setTaskCompleteVisible(false);
      window.location.href = "/";
    }, 1800);
  };

  const runWorkflow = async (options: RunWorkflowOptions = {}) => {
    if (workflowInFlightRef.current) {
      return;
    }

    if (workflowInputs.length === 0) {
      setWorkflowError("未检测到可生成内容的选题，请先在上一页选择选题");
      return;
    }

    const force = options.force !== false;
    const reusableGroups = force ? [] : pickReusableWorkflowGroups(workflowInputIds, workflowGroups);
    const inputsToGenerate = force
      ? workflowInputs
      : workflowInputs.filter(input => !reusableGroups.some(group => sameLink(group.shareLink, input.id)));

    if (!force) {
      const orderedReusableGroups = orderWorkflowGroupsByLinks(workflowInputIds, reusableGroups);
      setWorkflowRawDone("");
      setWorkflowGroups(orderedReusableGroups);
      safeSessionRemove("workflowRawDone");
      safeSessionSet("contentWorkflowGroups", JSON.stringify(orderedReusableGroups));
      setActiveGroupIndex(index => {
        const nextIndex = Math.min(Math.max(0, index), Math.max(0, orderedReusableGroups.length - 1));
        safeSessionSet("contentActiveGroupIndex", String(nextIndex));
        return nextIndex;
      });
    }

    if (inputsToGenerate.length === 0) {
      setWorkflowError(null);
      setWorkflowFailures([]);
      setWorkflowFallbackNotes([]);
      setWorkflowProgress(null);
      setStreamPreview("");
      return;
    }

    workflowInFlightRef.current = true;
    workflowAbortControllerRef.current?.abort();
    const controller = new AbortController();
    workflowAbortControllerRef.current = controller;

    const currentRunId = workflowRunIdRef.current + 1;
    workflowRunIdRef.current = currentRunId;
    const isCurrentRun = () => workflowRunIdRef.current === currentRunId;

    setWorkflowLoading(true);
    setWorkflowError(null);
    setWorkflowFailures([]);
    // 兜底提示只清掉「这次要重跑的那几条」：补跑 2 条时，其他 48 条的兜底提示不能被一起抹掉。
    setWorkflowFallbackNotes(previous => (
      force
        ? []
        : previous.filter(note => !inputsToGenerate.some(input => input.id === note.id))
    ));
    setWorkflowProgress({ done: 0, failed: 0, total: inputsToGenerate.length });
    setStreamPreview("");
    if (force) {
      setWorkflowRawDone("");
      setWorkflowGroups([]);
      setActiveGroupIndex(0);
      safeSessionRemove("workflowRawDone");
      safeSessionSet("contentWorkflowGroups", "[]");
      safeSessionSet("contentActiveGroupIndex", "0");
    } else {
      setWorkflowRawDone("");
      safeSessionRemove("workflowRawDone");
      setWorkflowGroups(reusableGroups);
      safeSessionSet("contentWorkflowGroups", JSON.stringify(reusableGroups));
      setActiveGroupIndex(index => {
        const nextIndex = Math.min(Math.max(0, index), Math.max(0, reusableGroups.length - 1));
        safeSessionSet("contentActiveGroupIndex", String(nextIndex));
        return nextIndex;
      });
    }

    try {
      const allGroups: WorkflowResultGroup[] = [...reusableGroups];
      // 每条选题的原始 Done payload，按「勾选项顺序」存：并发完成顺序是乱的，
      // 调试用的合并文本不能跟着乱（否则排查问题时看到的是随机顺序）。
      const payloadByIndex: string[] = new Array(inputsToGenerate.length).fill("");
      const failures: Array<{ id: string; title: string; message: string }> = [];
      let fatalError: Error | null = null;
      let finishedCount = 0;
      let failedCount = 0;

      const ensureCurrentRun = () => {
        if (!isCurrentRun()) {
          throw new Error("工作流任务已被新的请求替换");
        }
      };

      const commitPartialResults = () => {
        ensureCurrentRun();
        const combinedPayload = payloadByIndex.filter(Boolean).join("\n\n");
        const orderedGroups = orderWorkflowGroupsByLinks(workflowInputIds, allGroups);
        // 并发下数组会随完成顺序重排：把「当前正在看的那条」按 shareLink 重新定位，
        // 否则用户刚勾的标题会随着 index 指向变化被清空、卡片跳走。
        const previousActiveLink = String(
          workflowGroupsRef.current[activeGroupIndexRef.current]?.shareLink || "",
        ).trim();
        setWorkflowRawDone(combinedPayload);
        setWorkflowGroups(orderedGroups);
        if (previousActiveLink) {
          const nextIndex = findWorkflowGroupIndex(orderedGroups, previousActiveLink);
          if (nextIndex >= 0 && nextIndex !== activeGroupIndexRef.current) {
            setActiveGroupIndex(nextIndex);
            safeSessionSet("contentActiveGroupIndex", String(nextIndex));
          }
        }
        // 结果已经落到 state（内存）里，缓存写失败不应该把这条生成算成失败；
        // 缓存只影响刷新后能否恢复。
        safeSessionSet("workflowRawDone", combinedPayload);
        safeSessionSet("contentWorkflowGroups", JSON.stringify(orderedGroups));
      };

      /**
       * 一条选题的完整生成流程（请求 + SSE 解析 + 合并结果）。
       *
       * ⚠️ 每条**单独发一个请求**，不再把多条塞进一个请求：
       *   · 失败隔离：一条链接失效 / 一次模型超时只影响这一条，不会连坐整批；
       *   · 进度真实：哪条先完成就先把哪条合并进界面；
       *   · 后端 `runContentAgent` 内部本来就是逐条串行，塞多条只省 HTTP 往返、
       *     省不了模型时间 —— 真正的提速必须在这里并发。
       */
      const runOneTopic = async (input: (typeof workflowInputs)[number], inputIndex: number) => {
        ensureCurrentRun();

        const batchInputs = [input];
        const batchIds = batchInputs.map(item => item.id);
        const batchLinksText = batchInputs
          .filter(item => item.kind === "share_link")
          .map(item => item.link)
          .join("\n");
        const batchWechatTopics = batchInputs
          .filter(item => item.kind === "wechat_topic" && item.topic)
          .map(item => item.topic);

        // 单条看门狗：一条卡死时不能永远占着并发槽位（并发 3 时 3 条都卡住就整批不动）。
        // 超时只中止这一条，不碰整轮 controller。
        const topicSignal = typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function"
          ? AbortSignal.any([controller.signal, AbortSignal.timeout(CONTENT_TOPIC_TIMEOUT_MS)])
          : controller.signal;

        const response = await fetch(apiUrl("/api/agent/workflow/stream-run"), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            workflow_id: "7618854964156563519",
            source_platform: shareLinkPlatform,
            // 二创适配：客户 + 本批每条链接的库内大类。
            // 后端据此去选题库取「大类 → 三秒/结尾钩子配比」，再按配比给每个 agent
            // 指定 10 个槽位。取不到库时后端**自动退回原来的自由二创**，不会生成失败。
            customerId: sessionStorage.getItem("contentCustomerId") || "",
            content_adaptation: Object.fromEntries(
              batchInputs
                .filter(item => item.kind === "share_link")
                .map(item => [item.link, categoryNamesByLink[item.link] || ""])
                .filter(([, categoryName]) => Boolean(categoryName)),
            ),
            parameters: {
              share_links: batchLinksText,
              benchmark_topics: batchWechatTopics,
              // 选题页（近 7 天）已经把脚本提好了，随请求一起带过去，后端**直接复用**、
              // 不再 TikHub 解析（3~7s）+ 整条转写（10~45s）/条 —— 那是纯重复劳动。
              //
              // ⚠️ 两类条目都要带，键的口径不同但都必须与后端对齐：
              //    · 抖音/TikTok → `getTopicShareLink`（就是 share_links 里那一行）；
              //    · 视频号 → `getTopicWorkflowKey`（`wechat_channels:<id>`，后端
              //      `topicWorkflowKey` 用同一套字段优先级算出来的）。
              //    只带 share_link 的话**视频号会退回现场解密+转写** —— 而视频号要本地解密，
              //    比抖音慢得多，正是最该复用的一类。
              benchmark_videos: [
                ...benchmarkVideos
                  .filter(video => batchInputs.some(item => item.kind === "share_link" && item.link === video.link))
                  .map(video => ({
                    link: video.link,
                    title: video.title,
                    script: video.script || "",
                    scriptSource: video.scriptSource || "",
                  })),
                ...batchWechatTopics
                  .map(topic => ({
                    link: getTopicWorkflowKey(topic),
                    title: String((topic as TopicLike)?.title || ""),
                    script: String((topic as TopicLike)?.content?.script || ""),
                    scriptSource: String((topic as TopicLike)?.content?.scriptSource || ""),
                  })),
              ].filter(video => video.link && video.script),
            },
          }),
          signal: topicSignal,
        });

        if (!response.ok || !response.body) {
          const text = await response.text();
          const error = new Error(text || `HTTP ${response.status}`);
          (error as any).status = response.status;
          throw error;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let donePayload = "";
        let batchPreview = "";
        let seenDone = false;
        let emptyPayload = false;

        while (true) {
          ensureCurrentRun();

          let readResult;
          try {
            readResult = await reader.read();
          } catch (error) {
            // 已经收到 Done 且结果已提交：之后连接被重置/超时是服务端收尾问题，
            // 不能把这条已经成功的选题标成失败（否则 summary 与 groups 会自相矛盾）。
            if (seenDone) break;
            throw error;
          }
          const { value, done } = readResult;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";

          for (const chunk of chunks) {
            const lines = chunk.split("\n");
            let event = "";
            let dataLine = "";

            for (const line of lines) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) dataLine += line.slice(5).trim();
            }

            if (!event) continue;

            let data: any = {};
            try {
              data = dataLine ? JSON.parse(dataLine) : {};
            } catch {
              data = { raw: dataLine };
            }

            if (event === "Message") {
              const content = String(data?.content || "");
              if (content) {
                batchPreview += content;
                if (isCurrentRun()) {
                  setStreamPreview(prev => prev + content);
                }
                donePayload = content;
              }
            }

            if (event === "Progress") {
              // 服务端在单个创作 Agent 失败时会用规则兜底，产物照样有内容、界面上
              // 看不出区别。把 fallback 计数收集起来，生成完显式提示「这几条要重点检查」。
              const step = String(data?.step || "");
              const fallbackCount = Number(data?.fallbackCount || 0);
              const isFallbackStep = step === "creative-agents-fallback"
                || (step === "creative-agents-ready" && fallbackCount > 0);
              if (isFallbackStep && isCurrentRun()) {
                const count = step === "creative-agents-fallback" ? 4 : fallbackCount;
                setWorkflowFallbackNotes(previous => (
                  previous.some(item => item.id === input.id)
                    ? previous
                    : [...previous, { id: input.id, title: getWorkflowInputTitle(input, benchmarkVideos), count }]
                ));
              }
            }

            if (event === "Error") {
              // 保住后端给的状态码 / 错误码：401 / 凭证缺失要能被判定成「致命」，
              // 立刻停掉其他在途请求，而不是让剩下几十条陪跑一遍。
              const error = new Error(data?.error_message || `「${getWorkflowInputTitle(input, benchmarkVideos)}」生成失败`);
              (error as any).status = Number(data?.status) || 0;
              (error as any).code = String(data?.code || "");
              throw error;
            }

            if (event === "Done") {
              seenDone = true;
              const payloadText = donePayload || batchPreview;
              payloadByIndex[inputIndex] = payloadText;

              const grouped = parseWorkflowPayloadGroups(payloadText, batchIds);
              const normalized = grouped.length > 0
                ? grouped
                : [
                    {
                      id: `link-${inputIndex + 1}`,
                      shareLink: batchIds[0] || "",
                      result: parseWorkflowPayload(payloadText),
                    },
                  ];

              allGroups.push(...normalized);
              // Done 但三类产物全空 = 这条其实没生成成功。先记下来，等流自然结束后
              // 按失败处理：否则 `orderWorkflowGroupsByLinks` 会把它丢掉，effect 又认为
              // 「还缺结果」，可能反复自动重跑同一条（真实花钱）。
              emptyPayload = !normalized.some(item => hasWorkflowResult(item));
              if (!emptyPayload) {
                // 这条一出结果就立刻合并进界面（不必等其余并发中的选题）。
                commitPartialResults();
              }
            }
          }
        }

        if (!seenDone) {
          throw new Error(`「${getWorkflowInputTitle(input, benchmarkVideos)}」的生成连接已结束，但没收到 Done 事件（可能请求超时或中途被中断），请重试。`);
        }
        if (emptyPayload) {
          throw new Error(`「${getWorkflowInputTitle(input, benchmarkVideos)}」已返回，但标题 / 钩子 / 文案都为空，请重试。`);
        }
      };

      // 有界并发：每条选题内部已经是 4 个 Agent 并行，这里只控制「同时跑几条选题」。
      await mapWithConcurrency(inputsToGenerate, CONTENT_TOPIC_CONCURRENCY, async (input, inputIndex) => {
        if (fatalError) return;
        try {
          await runOneTopic(input, inputIndex);
          finishedCount += 1;
          setWorkflowProgress({ done: finishedCount, failed: failedCount, total: inputsToGenerate.length });
        } catch (error) {
          // 整轮被替换（用户又点了一次）/ 被取消：不记成「这条失败」，交给外层统一处理。
          if (!isCurrentRun() || controller.signal.aborted) throw error;

          // 单条看门狗触发的超时（整轮 controller 没被 abort）：只失败这一条。
          const isTopicTimeout = error instanceof DOMException
            && (error.name === "TimeoutError" || error.name === "AbortError");
          const message = isTopicTimeout
            ? `单条生成超时（超过 ${Math.round(CONTENT_TOPIC_TIMEOUT_MS / 60000)} 分钟），已跳过该条`
            : error instanceof Error ? error.message : "工作流执行失败";
          failures.push({ id: input.id, title: getWorkflowInputTitle(input, benchmarkVideos), message });
          failedCount += 1;
          setWorkflowProgress({ done: finishedCount, failed: failedCount, total: inputsToGenerate.length });
          setWorkflowFailures([...failures]);

          if (isFatalWorkflowError(error)) {
            // 登录失效 / 凭证缺失：剩下还在跑的请求注定一起失败，立即停掉。
            fatalError = error instanceof Error ? error : new Error(message);
            controller.abort();
          }
          throw error;
        }
      });

      if (!isCurrentRun()) {
        return;
      }
      if (controller.signal.aborted) {
        if (fatalError) throw fatalError;
        throw new DOMException("工作流任务已取消", "AbortError");
      }

      commitPartialResults();

      if (failures.length > 0) {
        const names = failures.slice(0, 3).map(item => `「${item.title}」`).join("、");
        setWorkflowError(
          `本轮已生成 ${finishedCount}/${inputsToGenerate.length} 条，${failures.length} 条失败：${names}${failures.length > 3 ? " 等" : ""}。成功的结果已保留，可点「补跑未生成」只补跑缺的。`,
        );
      }
    } catch (error) {
      if (!isCurrentRun()) {
        return;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        setWorkflowError("工作流任务已取消");
        return;
      }

      // 401/403 时服务端返回的是 JSON 原文，直接显示给用户没有意义。
      const status = Number((error as any)?.status || 0);
      const message = status === 401 || status === 403
        ? "登录已失效，请重新登录后再补跑未生成的选题。"
        : error instanceof Error ? error.message : "工作流执行失败";
      setWorkflowError(message);
    } finally {
      if (isCurrentRun()) {
        workflowAbortControllerRef.current = null;
        workflowInFlightRef.current = false;
        setWorkflowLoading(false);
      }
    }
  };

  useEffect(() => {
    safeSessionSet("contentWorkflowFailures", JSON.stringify(workflowFailures));
  }, [workflowFailures]);

  useEffect(() => {
    safeSessionSet("contentWorkflowFallbackNotes", JSON.stringify(workflowFallbackNotes));
  }, [workflowFallbackNotes]);

  useEffect(() => {
    const autoRunKey = sessionStorage.getItem("contentAutoRunKey") || "";
    const consumedKey = sessionStorage.getItem("contentAutoRunConsumedKey") || "";
    if (workflowInputs.length === 0 || workflowInFlightRef.current) return;
    // 这个 key 已经自动跑过（包含「上一次跑完但有失败」的情况）：**不再自动重跑**。
    // 失败 / 缺结果交给界面上的「补跑未生成（N）」按钮显式触发。
    // 否则刷新一次、返回一次就会悄悄再烧一遍模型调用（永久失败的链接会无限重试）。
    if (autoRunKey && consumedKey === autoRunKey) return;
    // 同一次挂载内也只自动跑一次。
    if (!autoRunKey || autoRunKeyRef.current === autoRunKey) return;

    autoRunKeyRef.current = autoRunKey;
    safeSessionSet("contentAutoRunConsumedKey", autoRunKey);
    runWorkflow({ force: false });
  }, [workflowInputs, workflowInputIds, workflowGroups]);

  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      <header className="border-b border-slate-200/80 bg-white/80 px-5 py-6 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
              <span className="h-2 w-2 rounded-full bg-blue-600" />
              CONTENT STUDIO
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">内容生成与确认</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              系统已生成多组内容方案，请逐步筛选并确认最终文案
            </p>
          </div>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-slate-200 bg-white text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900"
            onClick={() => {
              // 回**选题生成页**（/topics），不是回今日任务 ——
              // 原来写的是 `window.location.href = "/"`，对员工来说 "/" 就是今日任务，
              // 而且整页重载会把 SPA 状态（已抓的选题、滚动位置、当前任务）一起丢掉。
              navigate("/topics");
            }}
          >
            返回选题生成
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-5 py-6 sm:px-8 lg:px-10 lg:py-8">
        <div className="grid min-w-0 grid-cols-1 xl:grid-cols-[320px_minmax(0,1fr)] gap-6">
          <div className="min-w-0 space-y-4 break-words">
            <Accordion type="multiple" defaultValue={["context-1", "context-2"]} className="space-y-3">
              <AccordionItem value="context-1" className="border border-slate-200 rounded-xl bg-white">
                <AccordionTrigger className="px-4 py-3 text-sm font-semibold text-slate-800">
                  客户信息
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 text-sm text-slate-600 space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">客户名称</div>
                    <div className="mt-1">{activeTask?.customerName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">负责人</div>
                    <div className="mt-1">{activeTask?.ownerName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">平台账号</div>
                    <div className="mt-1">{activeTask?.platformName || "未提供"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">联系方式</div>
                    <div className="mt-1">{activeTask?.contact || "未提供"}</div>
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="context-2" className="border border-slate-200 rounded-xl bg-white">
                <AccordionTrigger className="px-4 py-3 text-sm font-semibold text-slate-800">
                  内容需求
                </AccordionTrigger>
                <AccordionContent className="px-4 pb-4 text-sm text-slate-600 space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">内容方向与约束条件</div>
                    <div className="mt-1">
                      {Array.isArray(activeTask?.contentRequirements) && activeTask?.contentRequirements.length > 0
                        ? activeTask?.contentRequirements.join("、")
                        : "未提供"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">补充说明</div>
                    <div className="mt-1">{activeTask?.notes || "未提供"}</div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          <div className="min-w-0 space-y-6">
            <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 space-y-3">
              <div>
                当前已选选题：{selectedTopics.length} 条。后续标题、3 秒留存、二创文案将基于这些真实选题数据生成。
              </div>
              {selectedTopics.length > CONTENT_TOPIC_CONCURRENCY && (
                <div className="text-xs text-slate-500">
                  共 {selectedTopics.length} 条：按每次 {CONTENT_TOPIC_CONCURRENCY} 条并发生成（单条内部 4 个 Agent 已经并行），
                  完成一条就先展示一条，不必等整批跑完。
                </div>
              )}
              {missingScriptCount > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  其中 {missingScriptCount} 条没有可复用的口播脚本（时间窗口 &gt;7 天 / 选题页还在提取 / 该条没提到）。
                  这些会先现场解析 + 转写再生成，单条约多 1~2 分钟，是整批时间的主要来源。
                </div>
              )}
              {unusableTopics.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  另有 {unusableTopics.length} 条选题没有可用链接，无法进入生成（也不会出现在「补跑未生成」里）。
                  请回选题页重新获取该账号作品后再选。
                </div>
              )}
              {duplicateLinkCount > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                  有 {duplicateLinkCount} 条选题链接重复：它们会共用同一份生成结果，卡片总数会比勾选数少 {duplicateLinkCount} 条。
                </div>
              )}
              {wechatTopics.length > 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  已包含 {wechatTopics.length} 条视频号选题。系统将使用媒体地址和 decode_key 解密后进入转写生成。
                </div>
              )}

              <div className="flex flex-wrap gap-2 items-center">
                <Button
                  onClick={() => runWorkflow({ force: true })}
                  disabled={workflowLoading || workflowInputs.length === 0}
                  className="bg-blue-600 hover:bg-blue-700 text-white"
                >
                  {workflowLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      生成中...
                    </>
                  ) : workflowGroups.length > 0 ? `重新生成全部（${workflowInputIds.length} 条）` : "重新生成内容"}
                </Button>
                {workflowLoading && workflowProgress && (
                  <span className="text-xs text-slate-500">
                    本轮已完成 {workflowProgress.done}/{workflowProgress.total} 条
                    {workflowProgress.failed > 0 ? `，失败 ${workflowProgress.failed} 条` : ""}
                    （并发 {CONTENT_TOPIC_CONCURRENCY}）
                  </span>
                )}
                {!workflowLoading
                  && missingGroupCount > 0
                  && hasRunEvidence && (
                  // `force: false` 只补跑缺结果的选题：已成功的由 pickReusableWorkflowGroups 复用，
                  // 不会为了几条失败把整批模型调用重付一遍。
                  // 条数以「输入 - 已有结果」为准 —— 致命错误中止后，后面没跑的条目不进失败列表。
                  <Button
                    variant="outline"
                    className="h-9 rounded-xl border-slate-200 bg-white text-slate-700"
                    onClick={() => runWorkflow({ force: false })}
                  >
                    补跑未生成（{missingGroupCount}）
                  </Button>
                )}
                {workflowError && <span className="text-xs text-red-600">{workflowError}</span>}
              </div>

              {!workflowLoading && missingGroupCount > 0 && hasRunEvidence && (
                // 用「输入 vs 已有结果」算出来的未生成清单，而不是只用内存里的失败列表：
                // 刷新后失败列表还在（sessionStorage），但即使它丢了，这里也能逐条列出
                // 是哪几条没生成、已成功的几条不会重跑 —— 这正是「48 成功 / 2 失败」场景。
                <details className="rounded-lg border border-rose-200 bg-rose-50 p-3" open>
                  <summary className="cursor-pointer text-xs font-semibold text-rose-700">
                    还有 {missingGroupCount} 条未生成（已成功的 {matchedWorkflowGroups.length} 条不会重跑）
                  </summary>
                  <ul className="mt-2 space-y-1 text-[11px] text-rose-700">
                    {missingInputs.map(input => {
                      const failure = visibleWorkflowFailures.find(item => item.id === input.id);
                      return (
                        <li key={input.id}>
                          「{getWorkflowInputTitle(input, benchmarkVideos)}」：
                          {failure ? failure.message : "上次生成未完成（中断，或还在队列里没轮到）"}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-[11px] text-rose-600">
                    点上方「补跑未生成（{missingGroupCount}）」只重跑这些；已成功的 {matchedWorkflowGroups.length} 条结果会保留，不会重复花模型调用。
                  </p>
                </details>
              )}

              {!workflowLoading && visibleFallbackNotes.length > 0 && (
                <details className="rounded-lg border border-amber-200 bg-amber-50 p-3" open>
                  <summary className="cursor-pointer text-xs font-semibold text-amber-700">
                    {visibleFallbackNotes.length} 条使用了兜底结果，建议重点检查
                  </summary>
                  <ul className="mt-2 space-y-1 text-[11px] text-amber-700">
                    {visibleFallbackNotes.map(item => (
                      <li key={item.id}>「{item.title}」：{item.count} 个 Agent 未拿到模型结果（可能是限流/超时），已用规则兜底。</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-amber-700">
                    这些条目的标题/文案可能是模板或原脚本兜底出来的。确认不放心时，可用上方「重新生成全部」重做整批（会重新消耗模型调用）。
                  </p>
                </details>
              )}

              {streamPreview && (
                <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">流式输出预览</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                    {streamPreview}
                  </pre>
                </details>
              )}

              {workflowRawDone && (
                <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <summary className="cursor-pointer text-xs font-semibold text-slate-700">Done 前最后 payload</summary>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                    {workflowRawDone}
                  </pre>
                </details>
              )}

              {selectedTopics.length > 0 && (
                <Accordion type="multiple" className="space-y-2">
                  {selectedTopics.map((topic, index) => (
                    <AccordionItem
                      key={topic?.id || index}
                      value={`topic-${topic?.id || index}`}
                      className="border border-slate-200 rounded-lg bg-slate-50"
                    >
                      <AccordionTrigger className="min-w-0 px-3 py-2 text-xs text-slate-700">
                        <span className="min-w-0 flex-1 truncate text-left text-slate-900 font-medium" title={topic?.title || "未命名选题"}>{compactTopicLabel(topic?.title || "未命名选题")}</span>
                      </AccordionTrigger>
                      <AccordionContent className="px-3 pb-3 text-xs text-slate-600 space-y-2">
                        <div className="max-h-32 overflow-auto whitespace-pre-wrap break-words">完整标题：{topic?.title || "未命名选题"}</div>
                        <div>作者：{topic?.authorName || "未知"}</div>
                        <div>{isWeChatChannelsTopic(topic) ? "视频号来源" : "链接"}：{describeTopicSource(topic) || "未提供"}</div>
                        <div>
                          数据：点赞 {formatMetric(readStat(topic, "likes", ["digg_count", "like_count", "likes"]))} / 评论 {formatMetric(readStat(topic, "comments", ["comment_count", "comments"]))} / 转发 {formatMetric(readStat(topic, "shares", ["share_count", "shares"]))} / 收藏 {formatMetric(readStat(topic, "bookmarks", ["collect_count", "favorite_count", "bookmark_count", "bookmarks"]))}
                        </div>
                        <div>原始数据：</div>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                          {JSON.stringify(topic?.rawData ?? topic, null, 2)}
                        </pre>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              )}
            </div>

            <Card className="bg-white border-slate-200 overflow-hidden">
              <CardHeader className="pb-3 border-b border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-slate-700">
                    当前任务卡片：
                    <span className="ml-1 font-semibold text-slate-900">
                      {workflowGroups.length > 0 ? `${activeGroupIndex + 1} / ${workflowGroups.length}` : "0 / 0"}
                    </span>
                    {savedDraftForCurrentGroup && (
                      <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                        已保存
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-2"
                      onClick={() => setActiveGroupIndex((prev) => Math.max(0, prev - 1))}
                      disabled={workflowGroups.length === 0 || activeGroupIndex <= 0}
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 px-2"
                      onClick={() => setActiveGroupIndex((prev) => Math.min(workflowGroups.length - 1, prev + 1))}
                      disabled={workflowGroups.length === 0 || activeGroupIndex >= workflowGroups.length - 1}
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

              </CardHeader>

              <CardContent className="pt-4">
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-stretch">
              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">标题</CardTitle>
                    <Badge className="bg-blue-50 text-blue-600">{funnelStatus.titleCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.titles.map((titleBlock) => {
                    const { titleLabel, detailLines } = formatTitleDisplay(titleBlock);
                    return (
                      <div
                        key={titleBlock}
                        className={`rounded-lg border px-3 py-2 text-sm transition ${
                          selectedTitles.includes(titleBlock)
                            ? "border-blue-400 bg-blue-50"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={selectedTitles.includes(titleBlock)}
                            onCheckedChange={() => toggleSelection(titleBlock, selectedTitles, setSelectedTitles)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-slate-900 break-words leading-5 font-medium">{titleLabel || titleBlock}</div>
                            {detailLines.length > 0 && (
                              <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap break-words leading-5">
                                {detailLines.join("\n")}
                              </div>
                            )}
                            {selectedTitles.includes(titleBlock) && (
                              <div className="text-xs text-blue-600 mt-1">已选为候选标题</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">3 秒留存</CardTitle>
                    <Badge className="bg-blue-50 text-blue-600">{funnelStatus.hookCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.hooks.map((hook) => {
                    const isSelected = selectedHooks.includes(hook.id);
                    const typeLabel = hook.hookType === "opening_text"
                      ? "开头钩子"
                      : hook.hookType === "ending_text"
                        ? "结尾钩子"
                        : "没有检测到钩子（unknown）";

                    return (
                      <div
                        key={hook.id}
                        className={`rounded-lg border px-3 py-3 text-sm transition ${
                          isSelected
                            ? "border-blue-400 bg-blue-50"
                            : "border-slate-200 bg-white"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleSelection(hook.id, selectedHooks, setSelectedHooks)}
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex items-center gap-2">
                              <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{typeLabel}</Badge>
                              {/* 按选题库大类配比生成的候选会带上它的三秒 / 结尾类型
                                  （如「求知欲」「引导互动」）—— 这就是「10 条按配比分配」
                                  在界面上的落地证据，不能只存不显示。 */}
                              {hook.hookTypeLabel && (
                                <Badge className="bg-blue-50 text-blue-600 hover:bg-blue-50">{hook.hookTypeLabel}</Badge>
                              )}
                            </div>
                            <div className="text-slate-900 whitespace-pre-wrap break-words leading-6">
                              {hook.content}
                            </div>
                            {isSelected && (
                              <div className="text-xs text-blue-600 mt-1">已进入下一筛选阶段</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200 flex flex-col h-[56vh] min-h-[420px] max-h-[680px]">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base font-semibold text-slate-900">二创文案</CardTitle>
                    <Badge className="bg-blue-50 text-blue-600">{funnelStatus.scriptCount} 已选</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 flex-1 min-h-0 overflow-auto pr-1">
                  {workflowResult.scripts.map((script) => (
                    <div
                      key={script.id}
                      className={`rounded-lg border ${
                        selectedScripts.includes(script.id)
                          ? "border-blue-400 bg-blue-50"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <label className="flex items-start gap-3 text-sm px-3 py-3">
                        <Checkbox
                          checked={selectedScripts.includes(script.id)}
                          onCheckedChange={() => toggleSelection(script.id, selectedScripts, setSelectedScripts)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-slate-900 font-medium break-words">{script.title}</div>
                          <div className="mt-1 text-xs text-slate-500 whitespace-pre-wrap break-words leading-5">
                            {toPreview(script.content, 72) || "（空）"}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="mt-2 h-7 px-2 text-xs"
                            onClick={() => setActiveScript({ title: script.title, content: script.content })}
                          >
                            打开大窗口阅读全文
                          </Button>
                          {selectedScripts.includes(script.id) && (
                            <div className="mt-2 text-xs text-blue-600">已进入最终组合</div>
                          )}
                        </div>
                      </label>
                    </div>
                  ))}
                </CardContent>
              </Card>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Layers className="h-4 w-4 text-blue-500" />
                      <CardTitle className="text-base font-semibold text-slate-900">中 / 英翻译（可选）</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{translationEnabled ? "已启用" : "未启用"}</span>
                      <Switch checked={translationEnabled} onCheckedChange={(v) => setTranslationEnabled(Boolean(v))} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-700">
                  <div className="text-xs text-slate-500">
                    启用后可对你在上方三个板块中勾选的内容执行中英翻译；关闭时不影响主流程。
                  </div>

                  {translationEnabled ? (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          onClick={runTranslationWorkflow}
                          disabled={translationLoading}
                          variant="outline"
                          className="border-blue-200 text-blue-700"
                        >
                          {translationLoading ? "翻译中..." : "执行翻译"}
                        </Button>
                        <span className="text-xs text-slate-500">
                          将翻译：标题 {selectedTitles.length} 条 / 3秒留存 {selectedHooks.length} 条 / 二创文案 {selectedScripts.length} 条
                        </span>
                      </div>

                      {translationError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {translationError}
                        </div>
                      )}

                      {translationItems.length > 0 ? (
                        <div className="max-h-80 overflow-auto space-y-2 pr-1">
                          {translationItems.map(item => (
                            <div key={item.id} className="rounded-lg border border-slate-200 px-3 py-2 bg-slate-50 space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] text-slate-500">来源：{item.sourceType}</div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="h-7 px-2 text-[11px]"
                                  onClick={async () => {
                                    const toCopy = String(item.translated || item.en || "");
                                    if (!toCopy) return;
                                    await navigator.clipboard.writeText(toCopy);
                                    setTranslationCopyHint("已复制翻译文案");
                                    setTimeout(() => setTranslationCopyHint(null), 1500);
                                  }}
                                >
                                  复制翻译
                                </Button>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">原文</div>
                                <div className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-5">
                                  {toPreview(item.original || item.zh || "", 110)}
                                </div>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">翻译结果</div>
                                <div className="text-sm text-slate-900 whitespace-pre-wrap break-words leading-6">
                                  {toPreview(item.translated || item.en || "", 120)}
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                onClick={() => setActiveTranslationItem(item)}
                              >
                                打开大窗口查看原文与翻译
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                          暂无翻译结果。你可以先勾选需要翻译的内容，再点击“执行翻译”。
                        </div>
                      )}

                      {translationCopyHint && (
                        <div className="text-xs text-emerald-600">{translationCopyHint}</div>
                      )}

                      {translationPreview && (
                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <summary className="cursor-pointer text-xs font-semibold text-slate-700">翻译流式输出预览</summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                            {translationPreview}
                          </pre>
                        </details>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                      翻译模块当前已关闭。你可以在需要时随时打开，不影响当前文案筛选与确认。
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-blue-500" />
                      <CardTitle className="text-base font-semibold text-slate-900">文案风格转写（可选）</CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-500">{rewriteEnabled ? "已启用" : "未启用"}</span>
                      <Switch checked={rewriteEnabled} onCheckedChange={(v) => setRewriteEnabled(Boolean(v))} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-slate-700">
                  <div className="text-xs text-slate-500">
                    启用后你可以从已筛选的二创文案中二次勾选，按目标平台一键转写；关闭时不影响主流程。
                  </div>

                  {rewriteEnabled ? (
                    <>
                      <div className="flex flex-wrap gap-2 items-center">
                        {[
                          { id: "douyin", label: "抖音" },
                          { id: "xiaohongshu", label: "小红书" },
                          { id: "wechat", label: "公众号" },
                        ].map(item => (
                          <Button
                            key={item.id}
                            type="button"
                            variant={rewriteTarget === item.id ? "default" : "outline"}
                            className={rewriteTarget === item.id ? "bg-blue-600 hover:bg-blue-700" : ""}
                            onClick={() => setRewriteTarget(item.id as RewritePlatform)}
                          >
                            {item.label}
                          </Button>
                        ))}
                      </div>

                      <div className="rounded-lg border border-slate-200 p-3 space-y-2">
                        <div className="text-xs text-slate-500">二次勾选需要转写的文案（来自你上方已勾选的二创文案）</div>
                        <div className="space-y-2 max-h-48 overflow-auto pr-1">
                          {workflowResult.scripts
                            .filter(script => selectedScripts.includes(script.id))
                            .map(script => {
                              const checked = rewriteSelection.includes(script.id);
                              return (
                                <label key={script.id} className={`flex items-start gap-2 rounded-md border px-2 py-2 ${checked ? "border-blue-300 bg-blue-50" : "border-slate-200"}`}>
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={() => toggleSelection(script.id, rewriteSelection, setRewriteSelection)}
                                  />
                                  <div className="text-xs text-slate-700 whitespace-pre-wrap break-words leading-5">
                                    {toPreview(script.content, 120)}
                                  </div>
                                </label>
                              );
                            })}
                          {workflowResult.scripts.filter(script => selectedScripts.includes(script.id)).length === 0 && (
                            <div className="text-xs text-slate-500">请先在上方“二创文案”中勾选至少一条。</div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          onClick={runRewriteWorkflow}
                          disabled={rewriteLoading}
                          variant="outline"
                          className="border-blue-200 text-blue-700"
                        >
                          {rewriteLoading ? "转写中..." : "执行平台转写"}
                        </Button>
                        <span className="text-xs text-slate-500">目标平台：{rewriteTarget}</span>
                      </div>

                      {rewriteError && (
                        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                          {rewriteError}
                        </div>
                      )}

                      {rewriteResults.length > 0 && (
                        <div className="space-y-2 max-h-72 overflow-auto pr-1">
                          {rewriteResults.map(item => (
                            <div key={item.id} className="rounded-lg border border-slate-200 p-3 bg-slate-50 space-y-2">
                              <div className="text-[11px] text-slate-500">目标平台：{item.target}</div>
                              <div>
                                <div className="text-[11px] text-slate-500">原文</div>
                                <div className="text-xs text-slate-700 whitespace-pre-wrap break-words">{item.original}</div>
                              </div>
                              <div>
                                <div className="text-[11px] text-slate-500">转写结果</div>
                                <div className="text-sm text-slate-900 whitespace-pre-wrap break-words">{item.rewritten}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {rewritePreview && (
                        <details className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <summary className="cursor-pointer text-xs font-semibold text-slate-700">转写流式输出预览</summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 text-[11px] text-slate-700 border border-slate-200">
                            {rewritePreview}
                          </pre>
                        </details>
                      )}
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                      转写模块当前已关闭。你可以在需要做平台改写时再开启，不影响当前文案筛选与确认。
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* ── 保存记录与导出（不经过发布仓也能导出飞书）──────────────── */}
            <Card className="bg-white border-slate-200">
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base font-semibold text-slate-900">保存记录与导出</CardTitle>
                  <span className="text-xs text-slate-500">
                    本批已保存 {savedDraftsForCurrentInputs.length} 条 · 待导出 {pendingDraftCount} 条
                  </span>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-700">
                <p className="text-xs leading-5 text-slate-500">
                  保存记录在服务端持久化，切题/刷新/重新进入都还在；只做选题二创时，不必经过发布仓也能从这里导出飞书。
                  导出**不会自动清空**记录，需要时用「清空保存记录」。
                </p>
                {savedDraftsError && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    读取已保存记录失败：{savedDraftsError}。仍可点「保存本条文案」重试。
                  </div>
                )}
                {savedDraftsForCurrentInputs.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                    还没有保存记录。在上方勾选标题 / 3 秒留存 / 结尾钩子 / 二创文案，再点底部的「保存本条文案」。
                  </div>
                ) : (
                  <ul className="max-h-56 space-y-1.5 overflow-auto pr-1">
                    {savedDraftsForCurrentInputs.map(draft => {
                      const isActive = savedDraftForCurrentGroup?.id === draft.id;
                      return (
                        <li
                          key={draft.id}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                            isActive ? "border-blue-200 bg-blue-50" : "border-slate-200 bg-slate-50"
                          }`}
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => jumpToSavedDraft(draft)}
                            title="点击定位到这条选题"
                          >
                            <div className="text-[11px] text-slate-400">
                              保存于 {new Date(draft.updatedAt || draft.createdAt).toLocaleString("zh-CN", { hour12: false })}
                            </div>
                          </button>
                          <button
                            type="button"
                            className="shrink-0 rounded px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50"
                            onClick={() => setDeleteDraftTarget(draft)}
                          >
                            删除
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    className="h-9 rounded-xl bg-blue-600 text-white hover:bg-blue-700"
                    disabled={editorLoading || saveDraftLoading || batchExportLoading || !activeGroup}
                    onClick={goToFinalEditor}
                  >
                    {editorLoading ? "读取文案中…" : "最终文案编辑页"}
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 rounded-xl border-slate-200"
                    disabled={batchExportLoading || savedDraftsForCurrentInputs.length === 0}
                    onClick={() => exportAllPendingDrafts("feishu")}
                  >
                    写入飞书文档
                  </Button>
                  <Button
                    variant="outline"
                    className="h-9 rounded-xl border-slate-200"
                    disabled={batchExportLoading || savedDraftsForCurrentInputs.length === 0}
                    onClick={() => exportAllPendingDrafts("bitable")}
                  >
                    写入多维表格
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-9 rounded-xl text-rose-600 hover:bg-rose-50"
                    disabled={batchExportLoading || pendingDraftCount === 0}
                    onClick={() => setClearDraftsOpen(true)}
                  >
                    清空保存记录
                  </Button>
                </div>
                {batchExportMessage && <div className="text-xs text-slate-600">{batchExportMessage}</div>}

                <div className="rounded-xl border border-slate-200 px-3 py-2.5">
                  <div className="text-xs font-semibold text-slate-700">飞书多维表格（导出前先绑定）</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={bitableNewName}
                      onChange={event => setBitableNewName(event.target.value)}
                      placeholder="新表格名称（可选）"
                      className="h-9 min-w-[160px] flex-1 rounded-lg border border-slate-200 px-3 text-xs outline-none focus:border-blue-300"
                    />
                    <Button
                      variant="outline"
                      className="h-9 rounded-lg px-3 text-xs"
                      disabled={bitableCreateLoading}
                      onClick={bindNewBitable}
                    >
                      {bitableCreateLoading ? "创建中…" : "新建表格"}
                    </Button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={bitableTargetUrl}
                      onChange={event => setBitableTargetUrl(event.target.value)}
                      placeholder="粘贴已有表格 URL"
                      className="h-9 min-w-[200px] flex-1 rounded-lg border border-slate-200 px-3 text-xs outline-none focus:border-blue-300"
                    />
                    <Button variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={bindExistingBitable}>
                      绑定
                    </Button>
                    <span className={`text-[11px] ${cachedBitableBinding.appToken ? "text-emerald-600" : "text-slate-400"}`}>
                      {cachedBitableBinding.appToken ? "已绑定" : "未绑定"}
                    </span>
                  </div>
                  {bitableBindingError && <div className="mt-1 text-[11px] text-rose-600">{bitableBindingError}</div>}
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>

      <div className="border-t border-slate-200/80 bg-white/90 px-5 py-4 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 max-w-full text-xs text-slate-500 break-words" role="status">
            {saveDraftMessage
              || (savedDraftForCurrentGroup
                ? `本条已保存：${new Date(savedDraftForCurrentGroup.updatedAt || savedDraftForCurrentGroup.createdAt).toLocaleString("zh-CN", { hour12: false })}`
                : (savedDraftsForCurrentInputs.length > 0 ? `本批已保存 ${savedDraftsForCurrentInputs.length} 条` : "当前选题未保存"))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" className="h-10 rounded-xl" onClick={() => exportAllPendingDrafts("feishu", true)} disabled={batchExportLoading || saveDraftLoading || !activeGroup || !hasCurrentSelection()}>
              导出本条二创到飞书
            </Button>
            <Button variant="outline" className="h-10 rounded-xl" onClick={() => exportAllPendingDrafts("bitable", true)} disabled={batchExportLoading || saveDraftLoading || !activeGroup || !hasCurrentSelection()}>
              导出本条二创到多维表格
            </Button>
            <Button
              variant="outline"
              className="h-10 rounded-xl border-slate-200 bg-white text-slate-700"
              onClick={saveCurrentDraft}
              disabled={saveDraftLoading || !activeGroup || !hasCurrentSelection()}
            >
              {saveDraftLoading ? "保存中…" : savedDraftForCurrentGroup ? "更新本条保存" : "保存本条文案"}
            </Button>
            <Button className="h-10 rounded-xl bg-blue-600 px-6 text-sm font-semibold text-white shadow-sm hover:bg-blue-700" onClick={goToPublishWarehouse} disabled={saveDraftLoading || batchExportLoading}>
              下一步：进入发布仓
            </Button>
          </div>
        </div>
      </div>

      {activeScript && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-white border border-slate-200 shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-slate-500">二创文案 · 独立阅读窗口</div>
                <div className="text-base font-semibold text-slate-900 break-words">{activeScript.title}</div>
              </div>
              <Button variant="outline" onClick={() => setActiveScript(null)}>
                关闭
              </Button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 font-sans">
                {activeScript.content}
              </pre>
            </div>
          </div>
        </div>
      )}

      {taskCompleteVisible && (
        <div className="fixed inset-0 z-[70] bg-slate-900/35 backdrop-blur-[2px] flex items-center justify-center p-4">
          <div className="relative w-full max-w-md rounded-2xl border border-emerald-200 bg-white shadow-2xl px-8 py-10 text-center overflow-hidden">
            <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-emerald-100/70" />
            <div className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full bg-blue-100/60" />
            <div className="relative">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 animate-pulse">
                <CheckCircle2 className="h-8 w-8" />
              </div>
              <h3 className="text-2xl font-semibold text-slate-900">任务完成</h3>
              <p className="mt-2 text-sm text-slate-600">本次文案已确认无误，正在为你跳转到选题生成页，继续下一个任务。</p>
            </div>
          </div>
        </div>
      )}

      {activeTranslationItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-[1px] flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[82vh] rounded-xl bg-white border border-slate-200 shadow-2xl flex flex-col">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm text-slate-500">中英翻译 · 独立阅读窗口</div>
                <div className="text-base font-semibold text-slate-900 break-words">来源：{activeTranslationItem.sourceType}</div>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    const toCopy = String(activeTranslationItem.translated || activeTranslationItem.en || "");
                    if (!toCopy) return;
                    await navigator.clipboard.writeText(toCopy);
                    setTranslationCopyHint("已复制翻译文案");
                    setTimeout(() => setTranslationCopyHint(null), 1500);
                  }}
                >
                  一键复制翻译
                </Button>
                <Button variant="outline" onClick={() => setActiveTranslationItem(null)}>
                  关闭
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-5 space-y-4">
              <div>
                <div className="text-xs text-slate-500 mb-1">原文</div>
                <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 font-sans rounded-md border border-slate-200 p-3 bg-slate-50">
                  {activeTranslationItem.original || activeTranslationItem.zh || ""}
                </pre>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">翻译结果</div>
                <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-900 font-sans rounded-md border border-blue-200 p-3 bg-blue-50">
                  {activeTranslationItem.translated || activeTranslationItem.en || ""}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={clearDraftsOpen}
        onOpenChange={setClearDraftsOpen}
        title="清空已保存记录？"
        description={`将删除当前任务下已保存的 ${savedDraftsForCurrentInputs.length} 条选题文案。导出前请确认已经写入飞书（导出不会自动清空）。`}
        confirmLabel="清空"
        loading={clearDraftsLoading}
        onConfirm={clearSavedDrafts}
      />

      <ConfirmDialog
        open={Boolean(deleteDraftTarget)}
        onOpenChange={open => { if (!open) setDeleteDraftTarget(null); }}
        title="删除这条保存记录？"
        description={deleteDraftTarget
          ? `「${deleteDraftTarget.topic?.title || "未命名选题"}」的保存记录会被删除；已导出的飞书内容不受影响。`
          : ""}
        confirmLabel="删除"
        loading={deleteDraftLoading}
        onConfirm={deleteSavedDraft}
      />

    </div>
  );
}
