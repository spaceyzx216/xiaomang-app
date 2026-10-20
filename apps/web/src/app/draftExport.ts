/** 导出和页面交接只使用明确属于当前客户、任务、选题的数据。 */
type Draft = Record<string, any>;
type Scope = { customerId?: string; taskId?: string; topics?: Array<{ id?: string; link?: string; shareLink?: string }> };
export type DraftExportBlock = "content" | "cover" | "copy" | "tags";

const value = (input: unknown) => String(input ?? "").trim();
const contentFields = ["titleDraft", "hookDraft", "endingHookDraft", "scriptDraft", "rewriteDraft", "translationDraft"] as const;

export const sameDraftTopic = (draft: Draft, topic: { id?: string; link?: string; shareLink?: string }) => {
  const id = value(topic?.id);
  if (id && value(draft?.topic?.id)) return id === value(draft.topic.id);
  const link = value(topic?.link || topic?.shareLink);
  return Boolean(link && link === value(draft?.topic?.shareLink));
};

export const filterExportDrafts = (items: Draft[], scope: Scope) => (Array.isArray(items) ? items : []).filter(item => {
  if (scope.customerId && value(item.customerId) !== value(scope.customerId)) return false;
  if (scope.taskId && value(item.taskId || item.taskInfo?.id) !== value(scope.taskId)) return false;
  return !scope.topics || scope.topics.some(topic => sameDraftTopic(item, topic));
});

/** 只比较影响正文的勾选，忽略浏览位置；未改选择时保留最终编辑过的稿件。 */
export const sameDraftSelection = (left: Draft | undefined, right: Draft | undefined) => {
  if (!left || !right) return false;
  const snapshot = (selection: Draft) => ({
    selectedTitles: selection.selectedTitles || [],
    selectedHooks: selection.selectedHooks || [],
    selectedScripts: selection.selectedScripts || [],
    rewriteSelection: selection.rewriteEnabled ? selection.rewriteSelection || [] : [],
    rewriteEnabled: Boolean(selection.rewriteEnabled),
    rewriteTarget: selection.rewriteEnabled ? selection.rewriteTarget || "" : "",
    rewriteResults: selection.rewriteEnabled ? (selection.rewriteResults || []).map((item: Draft) => [item.id, item.original, item.rewritten, item.target]) : [],
    translationEnabled: Boolean(selection.translationEnabled),
    translationItems: selection.translationEnabled ? (selection.translationItems || []).map((item: Draft) => [item.id, item.zh, item.en, item.sourceType]) : [],
  });
  return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
};

export const buildPublishExport = (selection: Draft | undefined, confirmed: Record<string, string> = {}) => {
  const cover = selection?.cover?.candidates?.find((item: Draft) => item.id === selection?.cover?.selectedId);
  const url = value(cover?.image?.url);
  const tags = [...Object.values(confirmed), ...(selection?.topicTags?.selected || [])]
    .map(value).filter(Boolean).map(tag => tag.startsWith("#") ? tag : `#${tag}`);
  return {
    coverUrl: /^https?:\/\//i.test(url) ? url : "",
    coverTitle: value(cover?.title),
    coverPrompt: value(cover?.prompt),
    coverInline: !/^https?:\/\//i.test(url) && Boolean(cover?.image?.dataUrl),
    copy: (selection?.publishCopy?.selected || []).map(value).filter(Boolean).join("\n"),
    tags: Array.from(new Set(tags)).join(" "),
  };
};

/** 最终编辑过的发布材料优先；之后修改过发布仓选择时才采用新选择。 */
export const withCurrentPublishSelection = (draft: Draft, selection: Draft | undefined, confirmed: Record<string, string>) => {
  if (!selection) return draft;
  if (draft.publishWarehouse && value(draft.updatedAt) > value(selection.updatedAt)) return draft;
  return { ...draft, publishWarehouse: buildPublishExport(selection, confirmed) };
};

/** 分块导出不能带上此前保存的其它块，即使它们属于同一选题。 */
export const pickDraftExportBlock = (draft: Draft, block: DraftExportBlock): Draft => {
  const result: Draft = {
    topic: draft.topic,
    customerId: draft.customerId,
    taskId: draft.taskId,
    taskInfo: draft.taskInfo,
    benchmarkVideos: draft.benchmarkVideos?.length ? draft.benchmarkVideos : draft.topic
      ? [{ title: draft.topic.title || "", link: draft.topic.shareLink || "" }] : [],
  };
  if (block === "content") {
    for (const field of contentFields) result[field] = draft[field] || "";
  } else {
    const publish = draft.publishWarehouse || {};
    result.publishWarehouse = block === "cover"
      ? Object.fromEntries(["coverUrl", "coverTitle", "coverPrompt", "coverInline"].map(key => [key, publish[key]]))
      : { [block]: publish[block] || "" };
  }
  return result;
};

export const hasDraftExportContent = (draft: Draft, block: DraftExportBlock) => block === "content"
  ? contentFields.some(field => value(draft[field]))
  : block === "cover"
    ? Boolean(draft.publishWarehouse?.coverUrl || draft.publishWarehouse?.coverInline)
    : Boolean(value(draft.publishWarehouse?.[block]));

/** 从持久化稿件恢复编辑器，不拿另一条选题的全局交接稿补空。 */
export const editorPayloadFromDraft = (draft: Draft, source: { id: string; index: number; total: number }) => ({
  ...Object.fromEntries(contentFields.map(field => [field, draft[field] || ""])),
  topic: draft.topic,
  customerId: draft.customerId,
  taskId: draft.taskId,
  taskInfo: draft.taskInfo,
  benchmarkVideos: draft.benchmarkVideos || [],
  selection: draft.selection,
  publishWarehouse: draft.publishWarehouse || null,
  sourceGroupId: source.id,
  sourceGroupIndex: source.index,
  totalGroups: source.total,
});

/** 只缩短显示，不修改保存和导出的原标题。 */
export const compactTopicLabel = (title: unknown, max = 56) => {
  const text = value(title).replace(/\s+/g, " ");
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};
