const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const pickStat = (item, keys) => {
  const blocks = [
    item,
    item?.stats,
    item?.rawData?.statistics,
    item?.rawData?.stats,
    item?.rawData?.statistics_data,
  ].filter(Boolean);

  for (const block of blocks) {
    for (const key of keys) {
      const value = block?.[key];
      if (value !== undefined && value !== null) return toNumber(value);
    }
  }
  return 0;
};

const normalizePublishDate = (value) => {
  if (!value) return "";
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return "";
    const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(value);
};

const firstHttpUrl = (...values) => {
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

const normalizeDurationSeconds = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.round(parsed > 10000 ? parsed / 1000 : parsed);
  }
  return 0;
};

export const normalizeBenchmarkVideos = (input = []) => {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const rawData = item?.rawData || item?.raw || {};
      const link =
        item?.link ||
        item?.shareLink ||
        rawData?.share_url ||
        rawData?.share_info?.share_url ||
        rawData?.video?.play_addr?.url_list?.[0] ||
        "";

      return {
        title: String(item?.title || rawData?.desc || rawData?.title || "未命名选题"),
        link: String(link || ""),
        coverUrl: firstHttpUrl(
          item?.coverUrl,
          item?.cover,
          rawData?.cover,
          rawData?.cover_url,
          rawData?.video?.cover,
          rawData?.video?.origin_cover,
          rawData?.video?.dynamic_cover,
          rawData?.video?.animated_cover,
        ),
        durationSeconds: normalizeDurationSeconds(
          item?.durationSeconds,
          item?.duration,
          rawData?.duration,
          rawData?.video_duration,
          rawData?.video?.duration,
          rawData?.video?.duration_ms,
        ),
        authorName: String(item?.authorName || rawData?.author?.nickname || rawData?.author_name || "未知"),
        publishDate: normalizePublishDate(item?.publishDate || rawData?.create_time || rawData?.createTime),
        likes: pickStat(item, ["likes", "digg_count", "like_count"]),
        comments: pickStat(item, ["comments", "comment_count"]),
        shares: pickStat(item, ["shares", "share_count"]),
        bookmarks: pickStat(item, ["bookmarks", "collect_count", "favorite_count", "bookmark_count"]),
        hotTopics: Array.isArray(item?.hotTopics) ? item.hotTopics.map(value => String(value || "")).filter(Boolean) : [],
        // 提取到的**原文案**（口播转写或平台文案）。多维表格要单独一列「原文案」——
        // ⚠️ 不在这里带出来的话，归一化会把它剥掉，那一列永远是空的（实测踩过）。
        script: String(item?.script || ""),
        scriptSource: String(item?.scriptSource || ""),
      };
    })
    .filter(item => item.title || item.link);
};

export const formatMetric = (value) => {
  const numeric = toNumber(value);
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1)}万`;
  return String(numeric);
};

const limitText = (value, maxLength) => String(value || "").trim().slice(0, maxLength);

/**
 * 发布仓三块产出（3.1 封面 / 3.2 发布文案 / 3.3 发布标签）的导出形状。
 *
 * ⚠️ 封面**只认 http(s) 外链**：出图接口可能回 base64 dataUrl，那种值有几 MB，
 *    写进飞书单元格会被 50000 字符上限截断成一段乱码，也会把本地草稿撑爆。
 *    所以 dataUrl 只用来在页面上预览，导出时如实标成「内嵌图片、无外链」。
 */
export const normalizePublishWarehouse = (input = {}) => {
  const source = input && typeof input === "object" ? input : {};
  const cover = source.cover && typeof source.cover === "object" ? source.cover : {};
  const coverUrl = firstHttpUrl(
    cover.url,
    cover.imageUrl,
    cover.coverUrl,
    source.coverUrl,
  );
  const coverInline = !coverUrl && Boolean(cover.dataUrl || cover.inlineDataUrl || source.coverInline);
  return {
    coverUrl,
    // 用户最终选中的那张封面在页面上是可以换成别的外链的，所以这里认字符串优先。
    coverTitle: limitText(cover.title || source.coverTitle, 300),
    coverPrompt: limitText(cover.prompt || source.coverPrompt, 1200),
    coverInline,
    copy: limitText(source.copy || source.publishCopy, 4000),
    tags: limitText(source.tags || source.publishTags, 1000),
  };
};

/** 三块都为空时不渲染这一段，避免给导出的文档塞一堆空标题。 */
export const hasPublishWarehouse = (value) => {
  const normalized = normalizePublishWarehouse(value);
  return Boolean(
    normalized.coverUrl
    || normalized.coverInline
    || normalized.coverTitle
    || normalized.copy
    || normalized.tags,
  );
};

/**
 * 三块产出拆成可直接写进单元格的三段文本。
 * markdown / CSV / 多维表格都从这里取，避免三处各拼一遍（口径会漂）。
 */
export const publishWarehouseCells = (value) => {
  const item = normalizePublishWarehouse(value);
  return {
    cover: [
      item.coverUrl
        ? `封面：${item.coverUrl}`
        : (item.coverInline ? "封面：内嵌图片（无外链，无法写入飞书）" : ""),
      item.coverTitle ? `封面标题：${item.coverTitle}` : "",
      item.coverPrompt ? `出图提示词：${item.coverPrompt}` : "",
    ].filter(Boolean).join("\n"),
    copy: item.copy,
    tags: item.tags,
  };
};

export const formatPublishWarehouseSection = (value, { omitEmpty = false } = {}) => {
  if (!hasPublishWarehouse(value)) return "未提供";
  const cells = publishWarehouseCells(value);
  if (omitEmpty) return [["发布封面", cells.cover], ["发布文案", cells.copy], ["发布标签", cells.tags]]
    .filter(([, content]) => content).map(([title, content]) => `## ${title}\n${content}`).join("\n\n");
  return [
    "## 发布封面",
    cells.cover || "未提供",
    "",
    "## 发布文案",
    cells.copy || "未提供",
    "",
    "## 发布标签",
    cells.tags || "未提供",
  ].join("\n");
};

export const formatDuration = (value) => {
  const total = Math.max(0, Math.round(Number(value || 0)));
  if (!total) return "未知";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
};

export const formatBenchmarkVideo = (item, index = 0) => [
  `对标视频 ${index + 1}`,
  `标题：${item?.title || "未命名选题"}`,
  `链接：${item?.link || "未提供"}`,
  item?.coverUrl ? `封面：${item.coverUrl}` : "",
  `时长：${formatDuration(item?.durationSeconds)}`,
  `作者：${item?.authorName || "未知"}`,
  item?.publishDate ? `发布时间：${item.publishDate}` : "",
  `数据：点赞 ${formatMetric(item?.likes)} / 评论 ${formatMetric(item?.comments)} / 转发 ${formatMetric(item?.shares)} / 收藏 ${formatMetric(item?.bookmarks)}`,
  Array.isArray(item?.hotTopics) && item.hotTopics.length > 0 ? `热词：${item.hotTopics.join("、")}` : "",
].filter(Boolean).join("\n");

export const formatBenchmarkSection = (videos) => {
  const normalized = normalizeBenchmarkVideos(videos);
  if (normalized.length === 0) return "未提供";
  return normalized.map(formatBenchmarkVideo).join("\n\n");
};

export const buildFinalDraftMarkdown = (draft = {}, options = {}) => {
  const heading = options.heading || "最终文案";
  // 分块载荷没有二创字段；仅输出当前发布块，避免导出一页空标题。
  const hasContentFields = ["titleDraft", "hookDraft", "endingHookDraft", "scriptDraft", "rewriteDraft", "translationDraft"]
    .some(key => Object.prototype.hasOwnProperty.call(draft, key));
  if (!hasContentFields && hasPublishWarehouse(draft.publishWarehouse)) {
    return [`# ${heading}`, "", formatPublishWarehouseSection(draft.publishWarehouse, { omitEmpty: true }), ""].join("\n");
  }
  // 发布仓的三块产出只在真的带了的时候才追加这一段：
  // 从内容生成页直接来最终编辑页（没经过发布仓）的草稿导出的文档与以前完全一致。
  const publishSection = hasPublishWarehouse(draft.publishWarehouse)
    ? ["", formatPublishWarehouseSection(draft.publishWarehouse)]
    : [];
  return [
    `# ${heading}`,
    "",
    "## 对标选题视频",
    formatBenchmarkSection(draft.benchmarkVideos),
    "",
    "## 标题",
    String(draft.titleDraft || ""),
    "",
    "## 3 秒留存",
    String(draft.hookDraft || ""),
    "",
    "## 结尾钩子",
    String(draft.endingHookDraft || ""),
    "",
    "## 二创文案",
    String(draft.scriptDraft || ""),
    "",
    "## 风格转写结果",
    String(draft.rewriteDraft || ""),
    "",
    "## 中英翻译结果",
    String(draft.translationDraft || ""),
    ...publishSection,
    "",
  ].join("\n");
};

/**
 * 多条已保存草稿合并成**一篇**飞书文档（每条一个「选题 N」标题）。
 *
 * 为什么放在服务端：前端把 items 发过来只是列表，导出侧要能一条条渲染；
 * 之前 PublishWarehouse 就发 `{ items }`，但服务端只认单条草稿，导出的文档是空的。
 * 现在单条接口与列表接口共用同一套 format 函数，两边不会再漂移。
 */
export const buildFinalDraftMarkdownForItems = (items = []) => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length === 0) return buildFinalDraftMarkdown({});
  if (list.length === 1) return buildFinalDraftMarkdown(list[0]);
  return list
    .map((item, index) => buildFinalDraftMarkdown(item, { heading: `选题 ${index + 1}` }))
    .join("\n\n---\n\n");
};

export const csvEscape = (value) => `"${String(value || "").replace(/"/g, '""')}"`;

export const rowsToCsv = (rows) => rows.map(row => row.map(csvEscape).join(",")).join("\n");

export const buildFinalDraftCsvRows = (draft = {}) => {
  const rows = [
    ["板块", "内容"],
    ["对标选题视频", formatBenchmarkSection(draft.benchmarkVideos)],
    ["标题", String(draft.titleDraft || "")],
    ["3秒留存", String(draft.hookDraft || "")],
    ["结尾钩子", String(draft.endingHookDraft || "")],
    ["二创文案", String(draft.scriptDraft || "")],
    ["风格转写结果", String(draft.rewriteDraft || "")],
    ["中英翻译结果", String(draft.translationDraft || "")],
  ];
  if (hasPublishWarehouse(draft.publishWarehouse)) {
    const cells = publishWarehouseCells(draft.publishWarehouse);
    rows.push(["发布封面", cells.cover], ["发布文案", cells.copy], ["发布标签", cells.tags]);
  }
  return rows;
};

export const buildDraftListCsvRows = (items = []) => [
  ["序号", "保存时间", "对标选题视频", "标题", "3秒留存", "结尾钩子", "二创文案", "风格转写结果", "中英翻译结果", "发布封面", "发布文案", "发布标签"],
  ...items.map((item, index) => {
    const cells = publishWarehouseCells(item?.publishWarehouse);
    return [
      String(index + 1),
      String(item?.createdAt || ""),
      formatBenchmarkSection(item?.benchmarkVideos),
      String(item?.titleDraft || ""),
      String(item?.hookDraft || ""),
      String(item?.endingHookDraft || ""),
      String(item?.scriptDraft || ""),
      String(item?.rewriteDraft || ""),
      String(item?.translationDraft || ""),
      cells.cover,
      cells.copy,
      cells.tags,
    ];
  }),
];
