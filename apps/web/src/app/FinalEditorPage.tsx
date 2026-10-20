import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import { FileText, ArrowLeft } from "lucide-react";
import { apiUrl, fetchWithRetry, parseApiJson } from "./api";
import { cacheFinalDraft, removeCachedFinalDraft } from "./finalDraftCache";

type BenchmarkVideo = {
  title?: string;
  link?: string;
  coverUrl?: string;
  durationSeconds?: number;
  authorName?: string;
  publishDate?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  bookmarks?: number;
  hotTopics?: string[];
};

/**
 * 发布仓（3.1 封面 / 3.2 发布文案 / 3.3 发布标签）交接下来的三块产出。
 *
 * ⚠️ 这里只带 http(s) 的封面外链，**不带 dataUrl**：出图可能回 base64，
 *    一张就有几 MB，塞进 sessionStorage 的 payload 会直接把配额撑爆（其它草稿一起丢）。
 *    只有内嵌图时会带 `coverInline`，页面如实说明「无外链、导不到飞书」。
 */
type PublishWarehousePayload = {
  coverUrl?: string;
  coverTitle?: string;
  coverPrompt?: string;
  coverInline?: boolean;
  copy?: string;
  tags?: string;
};

type FinalDraftPayload = {
  publishWarehouse?: PublishWarehousePayload | null;
  titleDraft?: string;
  hookDraft?: string;
  endingHookDraft?: string;
  scriptDraft?: string;
  rewriteDraft?: string;
  translationDraft?: string;
  selectedTitles?: Array<{ title: string; detail?: string; raw?: string }>;
  selectedHooks?: Array<{ id: string; content: string; hookType: string }>;
  selectedScripts?: Array<{ id: string; title: string; content: string }>;
  rewriteResults?: Array<{ id: string; original: string; rewritten: string; target: string }>;
  translationItems?: Array<{ id: string; zh: string; en: string; sourceType: string }>;
  benchmarkVideos?: BenchmarkVideo[];
  taskInfo?: {
    id?: string;
    customerName?: string;
    ownerName?: string;
    platformName?: string;
    contentDirection?: string;
  } | null;
  sourceGroupId?: string | null;
  sourceGroupIndex?: number;
  totalGroups?: number;
  topic?: {
    id?: string;
    title?: string;
    shareLink?: string;
    platform?: string;
  } | null;
  customerId?: string;
  taskId?: string;
  selection?: Record<string, unknown> | null;
};

const loadDraftPayload = (): FinalDraftPayload => {
  try {
    const raw = sessionStorage.getItem("finalDraftPayload");
    if (!raw) return {};
    return JSON.parse(raw) as FinalDraftPayload;
  } catch {
    return {};
  }
};

const joinNonEmpty = (lines: string[]) => lines.map(item => String(item || "").trim()).filter(Boolean).join("\n\n");

const formatMetric = (value?: number) => {
  const numeric = Number(value || 0);
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1)}万`;
  return String(numeric || 0);
};

const formatDuration = (value?: number) => {
  const total = Math.max(0, Math.round(Number(value || 0)));
  if (!total) return "未知";
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
};

export default function FinalEditorPage() {
  const navigate = useNavigate();
  const payload = useMemo(() => loadDraftPayload(), []);
  const benchmarkVideos = Array.isArray(payload.benchmarkVideos) ? payload.benchmarkVideos : [];

  const [titleDraft, setTitleDraft] = useState(() => payload.titleDraft ?? joinNonEmpty(
    (payload.selectedTitles || []).map((item, idx) => `${idx + 1}. ${item.title}${item.detail ? `\n${item.detail}` : ""}`)
  ));

  /**
   * 3 秒留存 = **开场钩子**（`hookType === "opening_text"`）。
   *
   * 🔴 原来这里把 `selectedHooks` 全塞进一个框，于是开场钩子和结尾钩子混在一起 ——
   *    导出到飞书时「生成3秒」和「生成结尾钩子」就没法分成两列（用户 2026-09-24 的列清单
   *    要求它们是两列）。所以按 hookType 拆开，各是各的可编辑段落。
   */
  const [hookDraft, setHookDraft] = useState(() => payload.hookDraft ?? joinNonEmpty(
    (payload.selectedHooks || [])
      .filter(item => (item.hookType || "opening_text") === "opening_text")
      .map((item, idx) => `${idx + 1}. ${item.content}`)
  ));

  /** 结尾钩子 = `hookType === "ending_text"` 那批（单独一列，不能和 3 秒混着写）。 */
  const [endingHookDraft, setEndingHookDraft] = useState(() => payload.endingHookDraft ?? joinNonEmpty(
    (payload.selectedHooks || [])
      .filter(item => item.hookType === "ending_text")
      .map((item, idx) => `${idx + 1}. ${item.content}`)
  ));

  const hasEndingHook = Boolean(payload.endingHookDraft) || (payload.selectedHooks || []).some(item => item.hookType === "ending_text");

  const [scriptDraft, setScriptDraft] = useState(() => payload.scriptDraft ?? joinNonEmpty(
    (payload.selectedScripts || []).map((item, idx) => `【文案 ${idx + 1}】\n${item.content}`)
  ));

  const [rewriteDraft, setRewriteDraft] = useState(() => payload.rewriteDraft ?? joinNonEmpty(
    (payload.rewriteResults || []).map((item, idx) => `【${idx + 1} | ${item.target}】\n${item.rewritten}`)
  ));

  const [translationDraft, setTranslationDraft] = useState(() => payload.translationDraft ?? joinNonEmpty(
    (payload.translationItems || []).map((item, idx) => `【${idx + 1} | ${item.sourceType}】\nZH: ${item.zh}\nEN: ${item.en}`)
  ));

  const [saveLoading, setSaveLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const localFallbackId = useMemo(() => `local_${Date.now()}`, []);

  // 两个入口共用已保存稿及发布仓已选材料；没有发布材料时页面如实说明。
  const publish = payload.publishWarehouse;
  const [publishCoverUrl, setPublishCoverUrl] = useState(() => String(publish?.coverUrl || ""));
  const [publishCopy, setPublishCopy] = useState(() => String(publish?.copy || ""));
  const [publishTags, setPublishTags] = useState(() => String(publish?.tags || ""));
  const hasPublishInput = Boolean(
    publish
    && (publish.coverUrl || publish.coverInline || publish.coverTitle || publish.copy || publish.tags),
  );

  const hasRewriteResult = Boolean(payload.rewriteDraft) || (payload.rewriteResults || []).length > 0;
  const hasTranslationResult = Boolean(payload.translationDraft) || (payload.translationItems || []).length > 0;

  const draftPayload = {
    titleDraft,
    hookDraft,
    // 结尾钩子单独存一列（飞书多维表格要「生成3秒」与「生成结尾钩子」两列分开）
    endingHookDraft,
    scriptDraft,
    rewriteDraft: hasRewriteResult ? rewriteDraft : "",
    translationDraft: hasTranslationResult ? translationDraft : "",
    benchmarkVideos,
    taskInfo: payload.taskInfo || null,
    // 身份与勾选快照：服务端按 owner+customer+task+topic upsert，
    // 「内容页保存过 → 发布仓 → 最终编辑页再保存」才能更新同一条而不是新增重复记录。
    topic: payload.topic || null,
    customerId: payload.customerId || "",
    taskId: payload.taskId || "",
    selection: payload.selection || null,
    // 发布仓的三块产出跟着草稿一起存 —— 飞书文档/多维表格的导出读的就是这份 saved draft，
    // 在这里的人工修改与二创共用同一条保存稿；发布仓各块仍可独立导出已选材料。
    publishWarehouse: hasPublishInput ? {
      coverUrl: publishCoverUrl.trim(),
      coverTitle: String(publish?.coverTitle || ""),
      coverPrompt: String(publish?.coverPrompt || ""),
      coverInline: Boolean(publish?.coverInline),
      copy: publishCopy,
      tags: publishTags,
    } : null,
  };

  const saveFinalDraft = async () => {
    setSaveLoading(true);
    setSaveMessage(null);
    try {
      const response = await fetchWithRetry(apiUrl("/api/final-drafts"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload),
      });
      const data = await parseApiJson(response);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      if (data?.item?.id) {
        cacheFinalDraft(data.item);
      }
      removeCachedFinalDraft(localFallbackId);
      const currentIndex = Number(payload.sourceGroupIndex || 0);
      const totalGroups = Number(payload.totalGroups || 0);
      const nextIndex = totalGroups > 0 ? Math.min(currentIndex + 1, totalGroups - 1) : 0;
      sessionStorage.setItem("contentActiveGroupIndex", String(nextIndex));
      setSaveMessage("保存成功，已返回内容生成页。");
      navigate("/content");
    } catch (error) {
      const fallbackItem = {
        id: localFallbackId,
        createdAt: new Date().toISOString(),
        ...draftPayload,
      };
      cacheFinalDraft(fallbackItem);
      setSaveMessage("服务器保存失败，已保存在当前浏览器。请留在本页重试保存；尚未保存到服务器。");
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      <header className="border-b border-slate-200/80 bg-white/80 px-5 py-6 backdrop-blur sm:px-8 lg:px-10">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
              <span className="h-2 w-2 rounded-full bg-blue-600" />
              FINAL DRAFT
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">最终文案编辑页</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">已自动载入上一步勾选内容，可直接编辑。</p>
          </div>
          <Button
            variant="outline"
            className="h-10 rounded-xl border-slate-200 bg-white text-slate-600 shadow-sm hover:border-slate-300 hover:text-slate-900"
            onClick={() => navigate("/content")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回内容确认页
          </Button>
        </div>
      </header>

      <div className="p-8 max-w-[1400px] mx-auto space-y-4">
        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">对标选题视频</CardTitle>
              <Badge className="bg-slate-100 text-slate-700">{benchmarkVideos.length} 条</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {benchmarkVideos.length > 0 ? benchmarkVideos.map((item, index) => (
              <div key={`${item.link || item.title || index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-1">
                <div className="font-medium text-slate-900 break-words">{index + 1}. {item.title || "未命名选题"}</div>
                <div className="break-all text-xs text-slate-500">{item.link || "未提供链接"}</div>
                <div className="text-xs text-slate-600">
                  作者：{item.authorName || "未知"}{item.publishDate ? ` · 发布时间：${item.publishDate}` : ""}
                </div>
                <div className="text-xs text-slate-600">
                  封面：{item.coverUrl ? <span className="break-all text-slate-500">{item.coverUrl}</span> : "未提供"} · 时长：{formatDuration(item.durationSeconds)}
                </div>
                <div className="text-xs text-slate-600">
                  点赞 {formatMetric(item.likes)} / 评论 {formatMetric(item.comments)} / 转发 {formatMetric(item.shares)} / 收藏 {formatMetric(item.bookmarks)}
                </div>
              </div>
            )) : (
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs text-slate-500">
                当前最终文案未携带对标视频信息。
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">标题</CardTitle>
              <Badge className="bg-blue-50 text-blue-600">可编辑</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <textarea value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} className="w-full min-h-36 rounded-md border border-slate-300 p-3 text-sm" />
          </CardContent>
        </Card>

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2"><CardTitle className="text-base">3 秒留存（开场钩子）</CardTitle></CardHeader>
          <CardContent>
            <textarea value={hookDraft} onChange={(e) => setHookDraft(e.target.value)} className="w-full min-h-28 rounded-md border border-slate-300 p-3 text-sm" />
          </CardContent>
        </Card>

        {/* 结尾钩子单独一段：它和开场钩子是两类东西，导出到飞书也是两列。 */}
        {hasEndingHook && (
          <Card className="bg-white border-slate-200">
            <CardHeader className="pb-2"><CardTitle className="text-base">结尾钩子</CardTitle></CardHeader>
            <CardContent>
              <textarea value={endingHookDraft} onChange={(e) => setEndingHookDraft(e.target.value)} className="w-full min-h-28 rounded-md border border-slate-300 p-3 text-sm" />
            </CardContent>
          </Card>
        )}

        <Card className="bg-white border-slate-200">
          <CardHeader className="pb-2"><CardTitle className="text-base">二创文案</CardTitle></CardHeader>
          <CardContent>
            <textarea value={scriptDraft} onChange={(e) => setScriptDraft(e.target.value)} className="w-full min-h-72 rounded-md border border-slate-300 p-3 text-sm leading-6" />
          </CardContent>
        </Card>

        {(hasRewriteResult || hasTranslationResult) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {hasRewriteResult && (
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-2"><CardTitle className="text-base">风格转写结果</CardTitle></CardHeader>
                <CardContent>
                  <textarea value={rewriteDraft} onChange={(e) => setRewriteDraft(e.target.value)} className="w-full min-h-44 rounded-md border border-slate-300 p-3 text-sm" />
                </CardContent>
              </Card>
            )}
            {hasTranslationResult && (
              <Card className="bg-white border-slate-200">
                <CardHeader className="pb-2"><CardTitle className="text-base">中英翻译结果</CardTitle></CardHeader>
                <CardContent>
                  <textarea value={translationDraft} onChange={(e) => setTranslationDraft(e.target.value)} className="w-full min-h-44 rounded-md border border-slate-300 p-3 text-sm" />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* ── 发布仓产出（3.1 封面 / 3.2 发布文案 / 3.3 发布标签）───────────────
            这三块和上面的标题/3秒/二创一样是**可编辑段落**，会跟着草稿一起保存，
            导出飞书文档与多维表格时一并带上。顺序与导出文档一致（放在最后一组）。 */}
        {hasPublishInput ? (
          <>
            <Card className="bg-white border-slate-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">发布封面</CardTitle>
                  <Badge className="bg-blue-50 text-blue-600">可编辑</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {publishCoverUrl ? (
                  <img
                    src={publishCoverUrl}
                    alt={publish?.coverTitle || "发布封面"}
                    className="w-full max-w-[240px] rounded-lg border border-slate-200 object-cover"
                  />
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-700">
                    这次封面只有内嵌图片、没有外链（出图接口回的是 base64），所以这里预览不了、
                    也写不进飞书的链接。需要链接的话，请在发布仓重新出一张、或直接把图片地址贴到下面。
                  </div>
                )}
                {publish?.coverTitle ? (
                  <div className="text-xs text-slate-500">封面标题：{publish.coverTitle}</div>
                ) : null}
                <label className="block text-xs font-medium text-slate-600">
                  封面图链接（导出到飞书用）
                  <input
                    value={publishCoverUrl}
                    onChange={(e) => setPublishCoverUrl(e.target.value)}
                    placeholder="https://..."
                    className="mt-1.5 w-full rounded-md border border-slate-300 p-2.5 text-sm"
                  />
                </label>
              </CardContent>
            </Card>

            <Card className="bg-white border-slate-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">发布文案</CardTitle>
                  <Badge className="bg-blue-50 text-blue-600">可编辑</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <textarea
                  value={publishCopy}
                  onChange={(e) => setPublishCopy(e.target.value)}
                  placeholder="发布仓里勾选的发布文案会出现在这里"
                  className="w-full min-h-40 rounded-md border border-slate-300 p-3 text-sm leading-6"
                />
              </CardContent>
            </Card>

            <Card className="bg-white border-slate-200">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">发布标签</CardTitle>
                  <Badge className="bg-blue-50 text-blue-600">可编辑</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <textarea
                  value={publishTags}
                  onChange={(e) => setPublishTags(e.target.value)}
                  placeholder="#标签 之间用空格分隔"
                  className="w-full min-h-28 rounded-md border border-slate-300 p-3 text-sm leading-6"
                />
              </CardContent>
            </Card>
          </>
        ) : (
          <Card className="bg-white border-slate-200">
            <CardContent className="pt-6">
              <div className="rounded-lg border border-dashed border-slate-300 px-3 py-4 text-xs leading-5 text-slate-500">
                这次没有经过发布仓（或发布仓里还没选封面/发布文案/发布标签），所以没有可并入的发布产出。
                需要的话先回发布仓确认，再回到本页保存。
              </div>
            </CardContent>
          </Card>
        )}

        {saveMessage && (
          <div className="text-sm text-slate-600">{saveMessage}</div>
        )}

        <div className="flex flex-wrap gap-2.5 justify-end">
          <Button
            className="h-10 rounded-xl bg-blue-600 px-5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
            onClick={saveFinalDraft}
            disabled={saveLoading}
          >
            <FileText className="mr-2 h-4 w-4" />
            {saveLoading ? "保存中..." : "保存最终文案"}
          </Button>
        </div>
      </div>
    </div>
  );
}
