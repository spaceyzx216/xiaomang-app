/**
 * 「最终文案草稿」的**纯数据部件**：归一化、按选题 upsert、按用户/客户/任务过滤。
 *
 * 为什么单独成文件：这套规则被**两套后端**共用（Express `src/index.js` 的本地 JSON 文件
 * store，以及 Vercel `api/final-drafts/*` 的内存 store）。以前两边各写一份归一化逻辑，
 * 时间一长必然漂移；抽成无 I/O 的纯函数后，两边只负责「读出来 → 调这里 → 写回去」，
 * 并由 `tests/final-draft-items.test.mjs` 直接钉住。
 *
 * ── 2026-10-19 为什么要加 owner/topic ────────────────────────────────────
 * 用户反馈「保存过的记录会互相覆盖、换页面就找不到」。原因是旧草稿只有一坨文本，
 * 没有「谁、哪个客户、哪个任务、哪条选题」这些身份，于是：
 *   · 每保存一条就 append 一条，同一选题重复保存会出现多份；
 *   · 列表是全局的，同一浏览器/部署下不同用户互相能看到；
 *   · 前端无法把草稿还原回某条选题的勾选状态。
 * 现在每条草稿带 ownerId + customerId + taskId + topic，按
 * `ownerId|customerId|taskId|topic.id` upsert —— 同一选题再保存是**更新**，
 * 不同选题互不覆盖；列表按 owner 过滤；`selection` 保存勾选 id 供前端还原。
 */

import { normalizeBenchmarkVideos, normalizePublishWarehouse } from "./exportFormatters.js";

/** 单个用户最多保留多少条草稿（每个任务几十条选题是常态，给足余量）。 */
export const MAX_DRAFT_ITEMS = 300;

const MAX_SECTION_CHARS = 20000;
const MAX_ID_CHARS = 240;
const MAX_TITLE_CHARS = 300;
const MAX_LINK_CHARS = 2000;

const text = (value, max = MAX_SECTION_CHARS) => String(value ?? "").slice(0, max);

const idText = value => text(value, MAX_ID_CHARS).trim();

const stringList = (value, { maxItems = 60, maxChars = MAX_LINK_CHARS } = {}) => (
  Array.isArray(value)
    ? value.map(item => text(item, maxChars).trim()).filter(Boolean).slice(0, maxItems)
    : []
);

const idList = (value, maxItems = 120) => (
  Array.isArray(value) ? value.map(idText).filter(Boolean).slice(0, maxItems) : []
);

const normalizeRewriteResults = value => (
  Array.isArray(value)
    ? value.slice(0, 30).map(item => ({
      id: idText(item?.id),
      original: text(item?.original),
      rewritten: text(item?.rewritten),
      target: text(item?.target, 40),
    })).filter(item => item.rewritten || item.original)
    : []
);

const normalizeTranslationItems = value => (
  Array.isArray(value)
    ? value.slice(0, 60).map(item => ({
      id: idText(item?.id),
      sourceType: text(item?.sourceType, 40),
      original: text(item?.original),
      translated: text(item?.translated),
      zh: text(item?.zh),
      en: text(item?.en),
    })).filter(item => item.translated || item.en)
    : []
);

const normalizeTopic = input => {
  const value = input && typeof input === "object" ? input : {};
  return {
    id: idText(value.id),
    title: text(value.title, MAX_TITLE_CHARS),
    shareLink: text(value.shareLink, MAX_LINK_CHARS),
    platform: text(value.platform, 40),
  };
};

/** 前端「勾选状态」：用来在切回旧选题时把标题/钩子/文案的勾选与改写结果还原出来。 */
export const normalizeDraftSelection = input => {
  const value = input && typeof input === "object" ? input : {};
  return {
    selectedTitles: stringList(value.selectedTitles),
    selectedHooks: idList(value.selectedHooks),
    selectedScripts: idList(value.selectedScripts),
    rewriteSelection: idList(value.rewriteSelection),
    rewriteResults: normalizeRewriteResults(value.rewriteResults),
    translationItems: normalizeTranslationItems(value.translationItems),
    rewriteEnabled: Boolean(value.rewriteEnabled),
    translationEnabled: Boolean(value.translationEnabled),
    rewriteTarget: text(value.rewriteTarget, 40),
    sourceGroupId: text(value.sourceGroupId, MAX_ID_CHARS),
    sourceGroupIndex: Number.isFinite(Number(value.sourceGroupIndex)) ? Math.max(0, Math.trunc(Number(value.sourceGroupIndex))) : 0,
    totalGroups: Number.isFinite(Number(value.totalGroups)) ? Math.max(0, Math.trunc(Number(value.totalGroups))) : 0,
  };
};

const hasSelection = selection => Boolean(
  selection
  && (selection.selectedTitles.length
    || selection.selectedHooks.length
    || selection.selectedScripts.length
    || selection.rewriteResults.length
    || selection.translationItems.length),
);

/** 把请求体归一化成一条可落库的草稿（不生成 id / 时间，供 upsert 时保留旧值）。 */
export const normalizeDraftFields = (body = {}, ownerId = "") => {
  const value = body && typeof body === "object" ? body : {};
  const taskInfo = value.taskInfo && typeof value.taskInfo === "object" ? value.taskInfo : {};
  return {
    ownerId: idText(ownerId),
    customerId: idText(value.customerId || taskInfo.customerId),
    taskId: idText(value.taskId || taskInfo.id),
    topic: normalizeTopic(value.topic),
    titleDraft: text(value.titleDraft),
    hookDraft: text(value.hookDraft),
    endingHookDraft: text(value.endingHookDraft),
    scriptDraft: text(value.scriptDraft),
    rewriteDraft: text(value.rewriteDraft),
    translationDraft: text(value.translationDraft),
    // 单条草稿最多带 60 条对标视频：一条选题通常只有 1~2 条，60 已远超正常用量。
    benchmarkVideos: normalizeBenchmarkVideos(value.benchmarkVideos).slice(0, 60),
    publishWarehouse: value.publishWarehouse && typeof value.publishWarehouse === "object"
      ? normalizePublishWarehouse(value.publishWarehouse)
      : null,
    selection: normalizeDraftSelection(value.selection),
    taskInfo: {
      id: idText(taskInfo.id),
      customerName: text(taskInfo.customerName, MAX_TITLE_CHARS),
      ownerName: text(taskInfo.ownerName, MAX_TITLE_CHARS),
      platformName: text(taskInfo.platformName, MAX_TITLE_CHARS),
      contentDirection: text(taskInfo.contentDirection, MAX_TITLE_CHARS),
    },
  };
};

let sequence = 0;
const nextDraftId = () => {
  sequence = (sequence + 1) % 100000;
  return `draft_${Date.now()}_${sequence.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
};

/** 新草稿（带 id / createdAt / updatedAt）。 */
export const buildDraftItem = (body = {}, ownerId = "") => {
  const now = new Date().toISOString();
  return {
    id: nextDraftId(),
    createdAt: now,
    updatedAt: now,
    ...normalizeDraftFields(body, ownerId),
  };
};

/**
 * upsert 的判重键：同一用户 + 同一客户 + 同一任务 + 同一选题 = 同一条记录。
 *
 * ⚠️ 没有 topic.id 的旧调用（例如最终编辑页直接保存）拿不到判重键，保持「每次新增」，
 *    不做模糊合并 —— 把两条不同选题误合并比多一份草稿更糟。
 */
export const draftScopeKey = item => {
  const value = item && typeof item === "object" ? item : {};
  const topicId = idText(value.topic?.id);
  if (!topicId) return "";
  return [idText(value.ownerId), idText(value.customerId), idText(value.taskId), topicId].join("|");
};

const keepText = (incoming, previous) => (
  String(incoming ?? "").trim() ? incoming : (previous ?? incoming)
);

const mergeDefined = (previous, incoming) => {
  const merged = { ...previous, ...incoming };
  // 文本段落：本次没带（空串）就保留旧值。
  // 「内容页保存」只带标题/二创时，不能把之前发布仓/最终编辑页保存的结尾钩子、改写、翻译冲成空。
  for (const field of ["titleDraft", "hookDraft", "endingHookDraft", "scriptDraft", "rewriteDraft", "translationDraft"]) {
    merged[field] = keepText(incoming[field], previous[field]);
  }
  // 对标视频同理：本次没带就保留旧的，避免导出时「对标视频」一栏突然空了。
  if ((!Array.isArray(incoming.benchmarkVideos) || incoming.benchmarkVideos.length === 0)
    && Array.isArray(previous.benchmarkVideos) && previous.benchmarkVideos.length > 0) {
    merged.benchmarkVideos = previous.benchmarkVideos;
  }
  // 没带发布仓产出时保留旧值：内容页「保存本条」不应该把发布仓挑好的封面/文案/标签冲掉。
  merged.publishWarehouse = incoming.publishWarehouse ?? previous.publishWarehouse ?? null;
  // 没带勾选状态时同样保留旧值；带了才覆盖。
  merged.selection = hasSelection(incoming.selection)
    ? incoming.selection
    : (previous.selection || incoming.selection);
  // 元信息缺字段时保留旧值（例如旧调用只传了文本）。
  merged.topic = {
    id: incoming.topic?.id || previous.topic?.id || "",
    title: incoming.topic?.title || previous.topic?.title || "",
    shareLink: incoming.topic?.shareLink || previous.topic?.shareLink || "",
    platform: incoming.topic?.platform || previous.topic?.platform || "",
  };
  merged.customerId = incoming.customerId || previous.customerId || "";
  merged.taskId = incoming.taskId || previous.taskId || "";
  merged.taskInfo = { ...(previous.taskInfo || {}), ...(incoming.taskInfo || {}) };
  return merged;
};

/**
 * 按判重键 upsert；没有 topic 的草稿照旧新增。返回新数组（不改入参）。
 *
 * 上限**按 owner 分别计算**：否则一个用户存满 300 条后，会开始把别人的记录挤掉。
 * 旧的无主草稿视为「任何人可见的公共旧数据」，不计入任何人的配额，也不主动淘汰。
 */
export const upsertDraftItems = (items, item, max = MAX_DRAFT_ITEMS) => {
  const list = Array.isArray(items) ? items : [];
  const key = draftScopeKey(item);
  if (key) {
    const index = list.findIndex(candidate => draftScopeKey(candidate) === key);
    if (index >= 0) {
      const next = list.slice();
      next[index] = {
        ...mergeDefined(list[index], item),
        // 身份与首次创建时间必须稳定：用户看到的记录 id 不应因为再保存一次而变化。
        id: list[index].id,
        createdAt: list[index].createdAt,
        updatedAt: item.updatedAt || new Date().toISOString(),
      };
      return next;
    }
  }

  const ownerId = String(item?.ownerId || "");
  const next = [item, ...list];
  const limit = Math.max(1, Number(max) || MAX_DRAFT_ITEMS);
  let keptOwnerItems = 0;
  return next.filter(candidate => {
    const candidateOwner = String(candidate?.ownerId || "");
    if (candidateOwner !== ownerId) return true;
    keptOwnerItems += 1;
    return keptOwnerItems <= limit;
  });
};

const isVisibleToOwner = (item, ownerId) => (
  // 旧版本草稿没有 ownerId：升级后不能凭空消失，暂时对所有人可见；首次再保存时会补上 owner。
  !item?.ownerId || String(item.ownerId) === String(ownerId || "")
);

const legacyScope = item => !item?.customerId || !item?.taskId;

const itemTime = item => String(item?.updatedAt || item?.createdAt || "");

/**
 * 列表：按 owner 过滤；可再按客户 / 任务收窄。
 *
 * `customerId` 不传 = 不过滤（内容页也会用它读全部，便于「已保存」列表跨任务展示）。
 * 旧草稿没有 customerId/taskId，不能因为筛选就被藏起来（用户会以为记录丢了），所以旧草稿始终保留。
 */
export const listDraftItems = (items, ownerId, options = {}) => {
  const customerId = idText(options.customerId);
  const taskId = idText(options.taskId);
  return (Array.isArray(items) ? items : [])
    .filter(item => isVisibleToOwner(item, ownerId))
    .filter(item => {
      if (!customerId && !taskId) return true;
      if (legacyScope(item)) return true;
      if (customerId && String(item.customerId) !== customerId) return false;
      if (taskId && String(item.taskId) !== taskId) return false;
      return true;
    })
    .slice()
    .sort((a, b) => itemTime(b).localeCompare(itemTime(a)));
};

/** 删除一条（只能删自己可见的）。 */
export const deleteDraftItem = (items, ownerId, id) => {
  const target = idText(id);
  const list = Array.isArray(items) ? items : [];
  let removed = 0;
  const next = list.filter(item => {
    if (target && String(item?.id || "") === target && isVisibleToOwner(item, ownerId)) {
      removed += 1;
      return false;
    }
    return true;
  });
  return { items: next, removed };
};

/** 清空当前用户可见的全部草稿（旧的无主草稿一并清掉）。 */
export const clearDraftItems = (items, ownerId) => {
  const list = Array.isArray(items) ? items : [];
  const next = list.filter(item => !isVisibleToOwner(item, ownerId));
  return { items: next, removed: list.length - next.length };
};

/** 选中一条草稿是否还「有内容」——导出前跳过全空记录。 */
export const draftHasContent = item => Boolean(
  item
  && (String(item.titleDraft || "").trim()
    || String(item.hookDraft || "").trim()
    || String(item.endingHookDraft || "").trim()
    || String(item.scriptDraft || "").trim()
    || item.selection?.selectedTitles?.length
    || item.selection?.selectedHooks?.length
    || item.selection?.selectedScripts?.length),
);
