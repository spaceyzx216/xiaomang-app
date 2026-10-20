import {
  buildDraftItem,
  clearDraftItems,
  deleteDraftItem,
  draftScopeKey,
  listDraftItems,
  upsertDraftItems,
} from "./draftItems.js";

/**
 * Vercel（serverless）侧的最终文案草稿 store。
 *
 * ⚠️ 这里存内存（每个 lambda 实例各一份，冷启动就丢），是历史实现；生产实际走
 * Express + `/app/data/final-drafts.json`。但两套后端必须保持**同一套口径**，
 * 所以归一化 / upsert / owner 过滤全部复用 `draftItems.js` 的纯函数，
 * 这边只负责「把数组存在内存里」。
 */
let items: Array<Record<string, any>> = [];

export const listDrafts = (ownerId: string, options: { customerId?: string; taskId?: string } = {}) =>
  listDraftItems(items, ownerId, options);

export const addDraft = (input: Record<string, any>, ownerId: string) => {
  const item = buildDraftItem(input, ownerId);
  items = upsertDraftItems(items, item);
  const scopeKey = draftScopeKey(item);
  return (scopeKey ? items.find(entry => draftScopeKey(entry) === scopeKey) : items[0]) || item;
};

export const deleteDraft = (id: string, ownerId: string) => {
  const result = deleteDraftItem(items, ownerId, id);
  items = result.items;
  return result.removed > 0;
};

export const clearDrafts = (ownerId: string) => {
  const result = clearDraftItems(items, ownerId);
  items = result.items;
  return result.removed;
};

/** 仅供测试/诊断：清空内存 store（不区分 owner —— 测试里用完即弃）。 */
export const resetDraftsForTest = () => {
  items = [];
};
