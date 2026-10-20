import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Check, Upload, X } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { apiUrl, fetchWithRetry } from "./api";
import { useAuth } from "./auth";
import { PublishSelectionDrafts, type PublishSelectionPatch } from "./publishSelectionDraft";
import { parseApiError } from "./reportApi";
import { readCachedFinalDrafts } from "./finalDraftCache";
import { buildPublishExport, compactTopicLabel, editorPayloadFromDraft, filterExportDrafts, hasDraftExportContent, pickDraftExportBlock, sameDraftTopic, withCurrentPublishSelection, type DraftExportBlock } from "./draftExport";
import {
  ACCOUNT_TAG_ANGLES,
  analyzeBenchmarkCover,
  deleteCoverBase,
  generateCoverImage,
  getCoverBase,
  listCoverTiers,
  listPublishSelections,
  requestAccountTags,
  requestCoverPlan,
  requestCoverTitleMetrics,
  requestPortraitPlan,
  requestPublishCopy,
  requestTopicTags,
  refineCoverImage,
  refineCoverStyle,
  saveAccountTags,
  saveCoverBase,
  savePublishSelection,
} from "./publishWarehouseApi";
import type {
  AccountTagLibrary,
  CoverAnalysis,
  CoverBase,
  CoverPlan,
  CoverTier,
  PublishCopyResult,
  PublishSelection,
  PublishTopicLike,
  TitleMetric,
  TitleStyleTemplate,
  TopicTagsResult,
} from "./publishWarehouseApi";

/**
 * 发布仓 —— 内容生成页之后的最后一步。
 *
 * 流程（用户 2026-09-21 拍板）：
 *   内容生成页（选标题/3秒/二创文案） → **发布仓**（选封面 / 发布文案 / 发布标签 + 核查 + 导出）
 *   → 最终文案编辑页
 *
 * 三块产出（见 HANDOFF §0.3 与 `docs/3.1~3.3`）：
 *   3.1 封面     按选题库的内容定位出提示词 → 人工确认 → 出图（唯一花钱的步骤）
 *   3.2 发布文案 金句 + 互动由 Agent 出；**标题与 3s 复用内容生成页已选的结果**，不重跑模型
 *   3.3 发布标签 账号恒定 3 个（三角度各确认 1）+ 每条选题 5 个（小类x2+核心内容x2+目标用户x1）
 *
 * ⚠️ 客户与大类都从「今日选题」的入口带下来（`contentCustomerId` + `topic.content.*`），
 *    **不在本页再选一次客户** —— 与 `/topics` 同一条口径（HANDOFF §0.1）。
 */

type TopicLike = PublishTopicLike;

const TABS = [
  { id: "cover", label: "3.1 封面" },
  { id: "copy", label: "3.2 发布文案" },
  { id: "tags", label: "3.3 发布标签" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const getSessionStorage = () => {
  try { return typeof sessionStorage === "undefined" ? undefined : sessionStorage; }
  catch { return undefined; }
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

const toPreview = (text: string, max = 90) => {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
};

/**
 * 这张图的 dataUrl 是不是**完整的**（没被切掉尾巴）。
 *
 * 为什么要判这个：出图网关产出的 2K 图曾经超过存储层上限被 `.slice()` 截断，
 * 截断出来的 base64 **预览可能还糊得出**，但发给网关当参考图就会报
 * 「One or more reference images are invalid…」（invalid_reference_image）——
 * 报错完全指向别处，排查方向被带偏过一整轮（2026-09-24 实测）。
 *
 * 判据看**文件结束标记**：PNG 必须以 IEND 结尾、JPEG 必须以 FF D9 结尾。
 * 缺了就是被切过。http(s) 外链没法在这儿验，一律放行（宁可漏判也不误判）。
 */
const isCompleteImageDataUrl = (value: string) => {
  const data = String(value || "");
  if (!data.startsWith("data:image/")) return true; // 外链：本地验不了，别误判
  const base64 = data.slice(data.indexOf(",") + 1);
  if (!base64) return false;
  // base64 要 4 字符对齐才能解码，所以取尾部对齐后的一小段来查结束标记。
  const take = Math.min(base64.length, 64);
  const aligned = take - (take % 4);
  let tail = "";
  try {
    tail = atob(base64.slice(base64.length - aligned));
  } catch {
    return false;
  }
  if (data.startsWith("data:image/png")) return tail.includes("IEND");
  if (data.startsWith("data:image/jpeg")) {
    const codes = [...tail].map(char => char.charCodeAt(0));
    for (let index = 0; index < codes.length - 1; index += 1) {
      if (codes[index] === 0xff && codes[index + 1] === 0xd9) return true;
    }
    return false;
  }
  return true; // 其它格式不做判断
};

/** 后端算标题字号用的设计稿宽度（对齐 publishWarehouse.js 的 TITLE_STYLE_DEFAULTS.canvasWidthPx）。 */
const TITLE_CANVAS_WIDTH = 1080;

/**
 * 把标题按「可用宽度」折成几行（画布导出用）。
 *
 * 与预览的差别：预览交给浏览器自然折行，画布得自己量宽度 —— 所以两边都用
 * 「最多几行 + 按长度收缩字号」这套同一口径，只是实现不同。
 */
const wrapCanvasText = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number) => {
  const chars = [...text];
  const lines: string[] = [];
  let current = "";
  for (const char of chars) {
    const next = current + char;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current);
      current = char;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines.length > 0 ? lines : [text];
};

const toggle = (list: string[], value: string) =>
  list.includes(value) ? list.filter(item => item !== value) : [...list, value];

/** 标题样式模板的空壳（用户还没调过时给输入框一个可编辑的起点）。 */
const emptyTitleStyle = (): TitleStyleTemplate => ({
  fontFamily: "",
  color: "",
  position: "bottom",
  alignment: "",
  note: "",
  fontSizePx: 64,
  minFontSizePx: 36,
  maxLines: 2,
});

/**
 * 把拆解结果拼成一份**可改的**背景模板提示词。
 *
 * 这只是给用户一个起点（拆解出的四个角度 + 留白），不是业务规则 ——
 * 提示词本来就是给人改的，所以在前端组装，不占后端一次调用。
 */
const composeTemplatePrompt = (analysis: CoverAnalysis | null) => {
  if (!analysis) return "";
  const lines = [
    analysis.artStyle && `画风：${analysis.artStyle}`,
    analysis.elements && `元素：${analysis.elements}`,
    analysis.layout && `排版：${analysis.layout}`,
    analysis.visualStyle && `视觉风格：${analysis.visualStyle}`,
    analysis.reservedAreas.length > 0 && `留白区域（不要放内容）：${analysis.reservedAreas.join("；")}`,
  ].filter(Boolean);
  if (lines.length === 0) return "";
  return [
    "模仿这张对标封面的风格，生成一张竖版 3:4 的封面背景模板。",
    "只画背景，不要出现任何文字。",
    ...lines,
  ].join("\n");
};

/** 基底的上次保存时间（到秒，与报告列表同一条口径 —— 同一天存过两版要分得清）。 */
const formatMetTime = (value: string) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/**
 * 图片上传区（拖拽或点击）。
 *
 * ⚠️ 定义在**组件外面**：写在页面组件里的话每次渲染都是新组件类型，
 *    React 会卸载重建整棵子树 —— 输入框会失焦、拖拽状态会丢（经典坑）。
 */
/**
 * 把上传的图**压到带得动的大小**再进后端。
 *
 * 🔴 为什么必须在浏览器里做：图片是以 base64 dataUrl 传的，一张手机拍的图 base64 后
 *    轻松超过 1MB（Express 全局 body 上限），而线上 Vercel 的请求体硬上限只有 4.5MB ——
 *    不压就是 413（`entity.too.large`，2026-09-24 实测日志）。
 *    压到长边 1440、JPEG q0.86 之后一张约 200~400KB，两个平台都过得去；
 *    封面设计稿按 1080 宽算，1440 留了余量。
 *
 * PNG 保留 PNG（可能有透明通道，转 JPEG 会把透明处压成黑边）；
 * 保留 PNG 仍太大（截图类）时再退回 JPEG —— 宁可丢透明，也不能传不上去。
 */
const downscaleDataUrl = async (dataUrl: string, maxEdge = 1440, quality = 0.86): Promise<string> => {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("图片读取失败"));
    element.src = dataUrl;
  });

  const width = image.naturalWidth || 0;
  const height = image.naturalHeight || 0;
  if (!width || !height) return dataUrl;

  // 本来就不大就别动它 —— 反复重编码只会掉画质。
  const longEdge = Math.max(width, height);
  const isPng = dataUrl.startsWith("data:image/png");
  if (longEdge <= maxEdge && dataUrl.length <= 900_000) return dataUrl;

  const scale = Math.min(1, maxEdge / longEdge);
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  // PNG 要透明底、不铺白；JPEG 铺白，否则透明处会变黑。
  if (!isPng) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

  const asPng = canvas.toDataURL("image/png");
  if (isPng && asPng.length <= 2_500_000) return asPng;
  const asJpeg = canvas.toDataURL("image/jpeg", quality);
  // 两个都比原始串更大的话就别折腾了。
  return asJpeg.length < dataUrl.length ? asJpeg : dataUrl;
};

/** 读文件 → 压图 → 返回可传的 dataUrl。 */
const readImageFile = async (file: File | null): Promise<string> => {
  if (!file) throw new Error("没有选择文件");
  if (!file.type.startsWith("image/")) throw new Error("只能上传图片");
  const raw = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  return downscaleDataUrl(raw);
};

function UploadDropzone({ label, hint, image, onPick }: {
  label: string;
  hint: string;
  image: { url: string; dataUrl: string } | null;
  onPick: (file: File) => void;
}) {
  const [over, setOver] = useState(false);
  const src = image?.url || image?.dataUrl || "";
  return (
    <label
      onDragOver={event => { event.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer?.files?.[0] || null;
        if (file) onPick(file);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-4 text-center transition ${
        over ? "border-blue-400 bg-blue-50" : "border-slate-300 hover:border-blue-300 hover:bg-blue-50/40"
      }`}
    >
      <input
        type="file"
        accept="image/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0] || null;
          // 清空 value：否则连续选同一个文件不会再触发 change。
          event.target.value = "";
          if (file) onPick(file);
        }}
      />
      {src ? (
        <>
          <img src={src} alt={label} className="mx-auto max-h-32 rounded-lg border border-slate-200 object-contain" />
          <div className="mt-2 text-[11px] text-slate-400">点击或拖入替换</div>
        </>
      ) : (
        <>
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
            <Upload className="h-4 w-4" />
          </span>
          <span className="mt-2 block text-xs font-medium text-slate-700">{label}</span>
          <span className="mt-0.5 block text-[11px] text-slate-400">{hint}</span>
        </>
      )}
    </label>
  );
}

export default function PublishWarehousePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const userId = String(user?.id || user?._id || "");

  const selectedTopics = useMemo(() => loadJson<TopicLike[]>("selectedTopics", []), []);
  const contentTasks = useMemo(() => loadJson<any[]>("contentTasks", []), []);
  const activeTask = contentTasks?.[0];
  const workflowGroups = useMemo(
    () => loadJson<Array<{ id: string; shareLink: string; result: any }>>("contentWorkflowGroups", []),
    [],
  );
  const customerId = useMemo(() => {
    try { return String(getSessionStorage()?.getItem("contentCustomerId") || "").trim(); }
    catch { return ""; }
  }, []);

  const [activeTab, setActiveTab] = useState<TabId>("cover");
  const [activeTopicIndex, setActiveTopicIndex] = useState(() => {
    const payload = loadJson<any>("finalDraftPayload", null);
    const index = selectedTopics.findIndex(topic => sameDraftTopic(payload, topic));
    return Math.max(0, index);
  });

  // Old queues must not send pending writes with a different login's cookie.
  const saveScope = useRef({ userId, customerId, active: false });
  saveScope.current.userId = userId;
  saveScope.current.customerId = customerId;
  useEffect(() => {
    saveScope.current.active = true;
    return () => { saveScope.current.active = false; };
  }, [userId, customerId]);

  // 每条的发布仓选择（按 topicId 存）。
  const [selections, setSelections] = useState<Record<string, PublishSelection>>({});
  const [loadingSelections, setLoadingSelections] = useState(false);
  const selectionDrafts = useMemo(() => new PublishSelectionDrafts(
    { userId, customerId },
    selectedTopics.map(topic => ({ id: String(topic.id || ""), title: String(topic.title || "") })),
    getSessionStorage(),
    (topicId, title, patch) => {
      const scope = saveScope.current;
      if (!scope.active || scope.userId !== userId || scope.customerId !== customerId) {
        return Promise.reject(new Error("登录用户或页面已切换，未保存的选择已留在原用户缓存中"));
      }
      return savePublishSelection({ customerId, topicId, title, ...patch });
    },
  ), [userId, customerId, selectedTopics]);
  const [saveStatus, setSaveStatus] = useState(() => selectionDrafts.snapshot());
  useEffect(() => selectionDrafts.subscribe(snapshot => {
    setSelections(snapshot.selections);
    setSaveStatus(snapshot);
  }), [selectionDrafts]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  // 3.1 封面
  const [coverPlan, setCoverPlan] = useState<CoverPlan | null>(null);
  const [coverLoading, setCoverLoading] = useState(false);
  const [coverImageLoading, setCoverImageLoading] = useState("");

  // 3.1 的子页：就三种类型（各一层）。两个可复用 Agent 的 UI 在每一层里按需引用，
  // **不再单独开页签** —— 页签只切三个类型之后，独立板块那条路已经不可达（见 3.1 里的注释）。
  // 进入某一层只是「看一下」，类型在保存基底时才落库。
  const [coverSubTab, setCoverSubTab] = useState<string>("standard");
  const [coverTiers, setCoverTiers] = useState<CoverTier[]>([]);
  const [coverBase, setCoverBase] = useState<CoverBase | null>(null);
  const [coverBaseLoading, setCoverBaseLoading] = useState(false);
  const [coverBaseSaving, setCoverBaseSaving] = useState(false);
  const [recognizeLoading, setRecognizeLoading] = useState(false);
  const [styleLoading, setStyleLoading] = useState(false);
  const [styleInput, setStyleInput] = useState("");
  const [styleChat, setStyleChat] = useState<Array<{ role: "user" | "model"; text: string }>>([]);
  const [portraitLoading, setPortraitLoading] = useState(false);
  const [baseImageLoading, setBaseImageLoading] = useState("");
  // 视觉模型这次识别出来的原始样式描述：用户改的时候常常是在否定它，所以留着一起发给模型。
  const [recognizedStyle, setRecognizedStyle] = useState<Record<string, unknown> | null>(null);
  const [baseSourceImage, setBaseSourceImage] = useState<{ url: string; dataUrl: string } | null>(null);
  const [baseAnalysis, setBaseAnalysis] = useState<CoverAnalysis | null>(null);
  const [baseTitleStyle, setBaseTitleStyle] = useState<TitleStyleTemplate | null>(null);
  const [baseBackgroundTemplate, setBaseBackgroundTemplate] = useState<{ url: string; dataUrl: string } | null>(null);
  const [baseBackgroundPrompt, setBaseBackgroundPrompt] = useState("");
  const [basePortraitPrompt, setBasePortraitPrompt] = useState("");
  const [basePortraitBasis, setBasePortraitBasis] = useState("");
  const [basePortraitImage, setBasePortraitImage] = useState<{ url: string; dataUrl: string } | null>(null);
  // 对话式改图：按**候选 id** 存对话记录，改完续在那一版上继续改。
  // loading 存正在改的候选 id → 改图期间禁用按钮（一次要几十秒，实测约 50s）。
  const [coverChats, setCoverChats] = useState<Record<string, Array<{ role: "user" | "model"; text: string }>>>({});
  const [coverChatInput, setCoverChatInput] = useState("");
  const [coverChatLoading, setCoverChatLoading] = useState("");
  /** 正在删除哪一张候选 —— in-flight 守卫，防双击删两条。 */
  const [coverDeletingId, setCoverDeletingId] = useState("");

  // 逐条的标题字号（后端算）——按「这条选题的标题」取。
  const [titleMetrics, setTitleMetrics] = useState<TitleMetric[]>([]);
  // 层二（每条出封面）的输入：这一期要用的标题 / 背景提示词 / 人像表情。
  // 它们是「这次要出的图」的输入，还不是候选，所以不写进 selection。
  const [perTopicTitle, setPerTopicTitle] = useState("");
  const [perTopicBackgroundPrompt, setPerTopicBackgroundPrompt] = useState("");
  const [perTopicExpression, setPerTopicExpression] = useState("");

  // 3.2 发布文案
  const [copyResult, setCopyResult] = useState<PublishCopyResult | null>(null);
  const [copyLoading, setCopyLoading] = useState(false);

  // 3.3 发布标签
  const [accountTags, setAccountTags] = useState<AccountTagLibrary | null>(null);
  const [accountTagsLoading, setAccountTagsLoading] = useState(false);
  const [accountConfirmed, setAccountConfirmed] = useState<Record<string, string>>({});
  const [topicTags, setTopicTags] = useState<TopicTagsResult | null>(null);
  const [topicTagsLoading, setTopicTagsLoading] = useState(false);

  // 导出 / 结束任务
  const [exporting, setExporting] = useState("");
  const bitableStorageKey = `xiaomang.feishuBitable.${String(activeTask?._id || activeTask?.customerName || "default").trim() || "default"}`;
  const [bitableUrl, setBitableUrl] = useState(() => {
    try {
      const binding = JSON.parse(localStorage.getItem(bitableStorageKey) || "{}");
      return String(binding.targetUrl || binding.bitableUrl || "");
    } catch { return ""; }
  });
  const updateBitableUrl = (url: string) => {
    setBitableUrl(url);
    try { localStorage.setItem(bitableStorageKey, JSON.stringify({ targetUrl: url, bitableUrl: url })); }
    catch { /* 当前页仍可使用输入的链接。 */ }
  };
  const [bitableNewName, setBitableNewName] = useState("");
  const [taskCompleteVisible, setTaskCompleteVisible] = useState(false);

  const activeTopic = selectedTopics[activeTopicIndex] || null;
  const activeTopicId = String(activeTopic?.id || "");
  const activeSelection = selections[activeTopicId] || null;

  /**
   * 把「内容生成页已选的结果」读回来 —— 3.2 的标题与 3s 要**复用**它们。
   *
   * 内容生成页把每个链接的结果放在 `contentWorkflowGroups`；
   * 这里按当前选题的链接取回它那一组，避免把别的选题的钩子串到这条上。
   */
  const activeGroupResult = useMemo(() => {
    const link = String(activeTopic?.link || activeTopic?.shareLink || "").trim();
    if (!link) return null;
    const group = workflowGroups.find(item => String(item?.shareLink || "").trim() === link);
    return group?.result || null;
  }, [workflowGroups, activeTopic]);

  const reuseTitles = useMemo(() => {
    const titles = Array.isArray(activeGroupResult?.titles) ? activeGroupResult.titles : [];
    const first = titles.map((item: any) => String(item || "").split("\n")[0].replace(/^《|》$/g, "").trim()).filter(Boolean);
    return first.slice(0, 4);
  }, [activeGroupResult]);

  const reuseThreeSeconds = useMemo(() => {
    const hooks = Array.isArray(activeGroupResult?.hooks) ? activeGroupResult.hooks : [];
    return hooks
      .filter((item: any) => item?.hookType === "opening_text")
      .map((item: any) => String(item?.content || "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }, [activeGroupResult]);

  const selectedScript = useMemo(() => {
    const scripts = Array.isArray(activeGroupResult?.scripts) ? activeGroupResult.scripts : [];
    const first = scripts.map((item: any) => String(item?.content || "").trim()).filter(Boolean)[0];
    return first || String(activeTopic?.content?.script || "").trim();
  }, [activeGroupResult, activeTopic]);

  // ── 载入已保存的发布仓（换批选题后恢复上次的勾选）─────────────────────────
  useEffect(() => {
    if (!customerId || !userId) return;
    let active = true;
    setLoadingSelections(true);
    listPublishSelections(customerId)
      .then(items => {
        if (!active) return;
        selectionDrafts.hydrate(items);
      })
      .catch(() => {
        if (active) setError("读取发布仓进度失败，已保留本地选择，请刷新重试");
      })
      .finally(() => { if (active) setLoadingSelections(false); });
    return () => { active = false; };
  }, [customerId, userId, selectionDrafts]);

  // 载入账号标签库（账号恒定，确认过一次就一直复用）。
  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setAccountTagsLoading(true);
    import("./publishWarehouseApi")
      .then(({ getAccountTags }) => getAccountTags(customerId))
      .then(library => {
        if (!active || !library) return;
        setAccountTags(library);
        setAccountConfirmed(library.confirmed || {});
      })
      .catch(() => { /* 没确认过就静默 */ })
      .finally(() => { if (active) setAccountTagsLoading(false); });
    return () => { active = false; };
  }, [customerId]);

  /**
   * 把读回来的封面基底灌进草稿态（首次进入、或保存后回读都走它）。
   *
   * 三类的资产**全部保留**、不按类型清空：用户可能在一类里配了模板、后来改选二类，
   * 再切回一类时那份模板还在（否则切一次类型就得重传一遍图）。
   */
  const applyCoverBase = useCallback((base: CoverBase | null) => {
    setCoverBase(base);
    if (!base) return;
    // 载入基底时把「正在看的那一类」也对齐到基底存的类型 ——
    // 否则又会变成「高亮一个类型、内容渲染另一个类型」。
    if (base.tier) setCoverSubTab(base.tier);
    setBaseSourceImage(base.sourceImage || null);
    setBaseAnalysis(base.analysis && (base.analysis.artStyle || base.analysis.summary) ? base.analysis : null);
    setBaseTitleStyle(base.titleStyle || null);
    setBaseBackgroundTemplate(base.backgroundTemplate || null);
    setBaseBackgroundPrompt(base.backgroundPrompt || "");
    setBasePortraitPrompt(base.portrait?.prompt || "");
    setBasePortraitBasis(base.portrait?.basis || "");
    setBasePortraitImage(base.portrait?.image || null);
  }, []);

  // 载入三类定义（后端 `COVER_TIERS`）与这个客户的封面基底。
  useEffect(() => {
    let active = true;
    listCoverTiers()
      .then(items => { if (active && items.length > 0) setCoverTiers(items); })
      .catch(() => { /* 读不到就退回只显示当前类型，不阻塞页面 */ });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let active = true;
    setCoverBaseLoading(true);
    getCoverBase(customerId)
      .then(base => { if (active) applyCoverBase(base); })
      .catch(() => { /* 没配过就静默 */ })
      .finally(() => { if (active) setCoverBaseLoading(false); });
    return () => { active = false; };
  }, [customerId, applyCoverBase]);

  // 当前类型（读不到定义时先用一个最小兜底，保证渲染不依赖网络）。
  const activeTier: CoverTier | null = useMemo(
    () => coverTiers.find(item => item.id === coverSubTab) || null,
    [coverTiers, coverSubTab],
  );

  /**
   * 这一条选题能不能出封面：缺什么就如实列出来（并在界面上把出口指回「封面基底」）。
   *
   * ⚠️ 一类没有背景模板（它的模板就是那张固定封面图），所以「模板」的判定要按类型分岔，
   *    统一写成「必须有 backgroundTemplate」会让一类永远显示缺东西。
   */
  const coverReadiness = useMemo(() => {
    const missing: string[] = [];
    if (!activeTier) missing.push("封面类型");
    const template = baseBackgroundTemplate || baseSourceImage;
    if (activeTier?.needsBackgroundTemplate) {
      if (!baseBackgroundTemplate) missing.push("背景风格模板");
    } else if (activeTier && !template) {
      missing.push("固定封面模板");
    }
    if (activeTier?.needsPortrait && !basePortraitImage) missing.push("IP 人像");
    return { ok: missing.length === 0, missing };
  }, [activeTier, baseBackgroundTemplate, baseSourceImage, basePortraitImage]);

  /**
   * 基底里的图上传（对标封面 / 背景模板 / IP 人像共用一套读取逻辑）。
   *
   * ⚠️ 读完之后**必须先压图**（downscaleDataUrl）——不压就 413，见那个函数的注释。
   */
  const handleBaseImageUpload = async (file: File | null, apply: (image: { url: string; dataUrl: string }) => void) => {
    try {
      const dataUrl = await readImageFile(file);
      apply({ url: "", dataUrl });
    } catch (error) {
      setError(error instanceof Error ? error.message : "图片读取失败");
    }
  };

  /**
   * 视觉识别：拆解上传的图（画风/元素/排版/视觉风格 + 留白），**并识别出标题样式**。
   *
   * 一类传的是那张固定封面模板，二/三类传的是对标封面 —— 同一套识别，
   * 所以「标题样式主要由视觉模型来识别」对三类都成立，用户不用手填六个字段。
   * 只调视觉模型，**不出图**。
   */
  const runRecognize = async (image: { url: string; dataUrl: string } | null) => {
    if (!image) {
      setError("请先上传一张图");
      return;
    }
    setRecognizeLoading(true);
    setError("");
    try {
      const result = await analyzeBenchmarkCover({ image });
      setBaseAnalysis(result.analysis);
      setBaseTitleStyle(result.titleStyle);
      setRecognizedStyle(result.titleStyle as unknown as Record<string, unknown>);
      setStyleChat([]);
      // 二/三类还要一份可改的背景模板提示词（一类不需要：它的背景就是那张模板图）。
      setBaseBackgroundPrompt(prev => prev.trim() ? prev : composeTemplatePrompt(result.analysis));
      if (!result.imageGenerationAvailable) {
        setError("服务器未配置出图密钥，暂时只能看识别结果，配好后即可生成图片。");
      } else {
        setMessage("已识别：画风 / 元素 / 排版 / 视觉风格 + 留白区域 + 标题样式。样式可以用下面的话框继续调。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "识别失败，换一张图或重试");
    } finally {
      setRecognizeLoading(false);
    }
  };

  /**
   * 用一句话调标题样式（用户口径：不要用死表单把用户框住）。
   * 把「识别出来的原始描述」一并带上 —— 用户常常是在否定它（「这不是书法体」）。
   */
  const runStyleRefine = async () => {
    const instruction = styleInput.trim();
    if (!instruction) return;
    setStyleLoading(true);
    setError("");
    const history = styleChat.slice(-6);
    setStyleChat(prev => [...prev, { role: "user", text: instruction }]);
    setStyleInput("");
    try {
      const result = await refineCoverStyle({
        titleStyle: baseTitleStyle || emptyTitleStyle(),
        instruction,
        recognized: recognizedStyle,
        history,
      });
      setBaseTitleStyle(result.titleStyle);
      setStyleChat(prev => [...prev, { role: "model", text: result.reply || "已按你说的调整。" }]);
    } catch (requestError) {
      setStyleChat(prev => [...prev, { role: "model", text: `没调成：${requestError instanceof Error ? requestError.message : "请求失败"}` }]);
    } finally {
      setStyleLoading(false);
    }
  };

  /** 出 IP 形象照的提示词建议（账号级）—— 人工改过之后才出图。 */
  const runPortraitPlan = async () => {
    setPortraitLoading(true);
    setError("");
    try {
      const result = await requestPortraitPlan({ customerId });
      setBasePortraitPrompt(String(result.ipPortrait?.prompt || ""));
      setBasePortraitBasis(String(result.ipPortrait?.basis || ""));
      setMessage("已给出 IP 形象照的提示词建议，确认后再出图。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "IP 形象照提示词生成失败");
    } finally {
      setPortraitLoading(false);
    }
  };

  /** 基底里的一次出图（背景风格模板 / IP 形象照）。唯一花钱的动作，必须点了才走。 */
  const makeBaseImage = async (kind: "backgroundTemplate" | "portrait") => {
    const prompt = kind === "portrait" ? basePortraitPrompt.trim() : baseBackgroundPrompt.trim();
    if (!prompt) {
      setError(kind === "portrait" ? "请先确认 IP 形象照的提示词" : "请先确认背景模板的提示词");
      return;
    }
    setBaseImageLoading(kind);
    setError("");
    try {
      // 背景模板拿对标封面当参考图（模仿它的风格）；IP 形象照拿客户参考照片当参考图。
      const referenceImages = kind === "backgroundTemplate"
        ? (baseSourceImage ? [baseSourceImage] : [])
        : (basePortraitImage ? [basePortraitImage] : []);
      const result = await generateCoverImage({
        prompt,
        referenceImages,
        size: "2K",
        quality: "high",
        aspectRatio: "3:4",
      });
      const rawImage = result.images?.[0];
      if (!rawImage) throw new Error("出图接口没有返回图片");
      // ⚠️ 出图结果同样要压：网关的 2K 图 base64 后约 5MB 字符，不压会撞存储层上限，
      //    也会让请求体超过 Vercel 的 4.5MB（上传路径早压了，出图路径漏了）。
      const image = { url: rawImage.url || "", dataUrl: await downscaleDataUrl(rawImage.dataUrl || rawImage.url || "") };
      const ref = { url: image.url || "", dataUrl: image.dataUrl || "" };
      if (kind === "portrait") {
        setBasePortraitImage(ref);
        setMessage("已生成 IP 形象照，确认后保存基底。");
      } else {
        setBaseBackgroundTemplate(ref);
        setMessage("已生成背景风格模板，确认后保存基底。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "出图失败");
    } finally {
      setBaseImageLoading("");
    }
  };

  /** 保存封面基底（账号级，幂等 upsert）。 */
  const persistCoverBase = async (nextTier = coverSubTab) => {
    if (!customerId) {
      setError("没有读到客户信息，无法保存封面基底");
      return;
    }
    setCoverBaseSaving(true);
    setError("");
    try {
      const saved = await saveCoverBase({
        customerId,
        customerName: String(activeTask?.customerName || ""),
        tier: nextTier,
        sourceImage: baseSourceImage,
        analysis: baseAnalysis,
        titleStyle: baseTitleStyle,
        backgroundTemplate: baseBackgroundTemplate,
        backgroundPrompt: baseBackgroundPrompt,
        portrait: { prompt: basePortraitPrompt, basis: basePortraitBasis, image: basePortraitImage },
      });
      applyCoverBase(saved);
      setMessage("封面基底已保存（账号级，之后每期复用）");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "封面基底保存失败");
    } finally {
      setCoverBaseSaving(false);
    }
  };

  const clearCoverBase = async () => {
    if (!customerId) return;
    setCoverBaseSaving(true);
    setError("");
    try {
      await deleteCoverBase(customerId);
      applyCoverBase(null);
      setBaseSourceImage(null);
      setBaseAnalysis(null);
      setBaseTitleStyle(null);
      setBaseBackgroundTemplate(null);
      setBaseBackgroundPrompt("");
      setBasePortraitPrompt("");
      setBasePortraitBasis("");
      setBasePortraitImage(null);
      setTitleMetrics([]);
      setMessage("封面基底已清空，可以重新选类型");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "清空封面基底失败");
    } finally {
      setCoverBaseSaving(false);
    }
  };

  const persist = useCallback((
    topicId: string,
    patch: PublishSelectionPatch | ((current: PublishSelection) => PublishSelectionPatch),
  ) => selectionDrafts.update(topicId, patch), [selectionDrafts]);

  // Checkbox handlers deliberately leave failures in the persistent save notice.
  const selectImmediately = (topicId: string, patch: PublishSelectionPatch | ((current: PublishSelection) => PublishSelectionPatch)) => {
    void persist(topicId, patch).catch(() => { /* Draft and retry notice remain visible. */ });
  };

  // ── 3.1 封面 ──────────────────────────────────────────────────────────────
  const loadCoverPlan = async (topic: TopicLike | null) => {
    if (!topic) return;
    setCoverLoading(true);
    setError("");
    try {
      const result = await requestCoverPlan({
        customerId,
        topic: {
          topicId: String(topic.id || ""),
          title: String(topic.title || ""),
          threeSeconds: String(topic.content?.threeSeconds || ""),
          script: selectedScript,
          categoryName: String(topic.content?.categoryName || ""),
          subcategoryName: String(topic.content?.subcategoryName || ""),
        },
      });
      setCoverPlan(result.plan);
      // 出方案顺带把第一个背景候选填进「这一期的背景」输入框，用户可直接改（一类的候选提示词不上这儿用）。
      setPerTopicBackgroundPrompt(prev => prev.trim() ? prev : String(result.plan?.backgrounds?.[0]?.prompt || ""));
      if (!result.imageGenerationAvailable) {
        setError("服务器未配置出图密钥（XXCAPI_API_KEY），可以先用提示词，配好后即可出图。");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "封面方案生成失败");
    } finally {
      setCoverLoading(false);
    }
  };

  const makeCoverImage = async (prompt: string, title: string, keywords: string[]) => {
    if (!prompt.trim()) {
      setError("请先确认出图提示词");
      return;
    }
    // ⚠️ 出图是全流程最慢的一步（按钮上就写着「较慢」），期间用户完全可能切到别的选题。
    //    所以把「发起时」的选题与已选状态先定格：否则 await 回来读到的 activeTopicId 是切走之后的，
    //    这张已经花过钱的图会落到**别的选题**上，而原选题什么都没留下。
    const topicId = activeTopicId;
    const baseSelection = activeSelection;
    const baseCandidates = baseSelection?.cover?.candidates || [];
    const titleStyle = baseSelection?.cover?.titleStyle || coverPlan?.titleStyle || null;
    // 出图期间用户可能换类型/换基底，所以这一刻也定格。
    const tier = coverSubTab;
    // 参考图同样定格：背景风格模板（模仿风格）+ IP 人像（二类同一张脸、三类换表情）。
    // ⚠️ 以前读的是页面上的一个临时上传（`referenceDataUrl`），那个入口删掉后就恒为空 ——
    //    等于「参考图编辑」这条链静默失效。现在改为读封面基底，跟着类型走。
    // 参考图按类型给：
    //   一类：那张**固定模板**（模型要在它上面改标题、出新的整图）
    //   二/三类：背景风格模板（模仿风格）+ IP 人像（二类同一张脸、三类换表情）
    const generationRefs = [
      ...(tier === "standard" ? [baseSourceImage] : []),
      baseBackgroundTemplate,
      basePortraitImage,
    ]
      .filter(Boolean)
      .map(item => ({ url: item?.url || "", dataUrl: item?.dataUrl || "" }))
      .filter(item => item.url || item.dataUrl);
    setCoverImageLoading(title || prompt.slice(0, 20));
    setError("");
    try {
      const result = await generateCoverImage({
        prompt,
        referenceImages: generationRefs,
        size: "2K",
        quality: "high",
        aspectRatio: "3:4",
      });
      const rawImage = result.images?.[0];
      if (!rawImage) throw new Error("出图接口没有返回图片");
      // ⚠️ 出图结果同样要压：网关的 2K 图 base64 后约 5MB 字符，不压会撞存储层上限，
      //    也会让请求体超过 Vercel 的 4.5MB（上传路径早压了，出图路径漏了）。
      const image = { url: rawImage.url || "", dataUrl: await downscaleDataUrl(rawImage.dataUrl || rawImage.url || "") };
      const candidates = [
        ...baseCandidates,
        {
          id: `cover-${baseCandidates.length + 1}`,
          title: title || `封面 ${baseCandidates.length + 1}`,
          keywords,
          prompt,
          image: { url: image.url || "", dataUrl: image.dataUrl || "" },
          tier,
        },
      ];
      await persist(topicId, {
        cover: { selectedId: candidates[candidates.length - 1].id, candidates, titleStyle },
      });
      setMessage(`已生成封面「${title}」`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "出图失败");
    } finally {
      setCoverImageLoading("");
    }
  };

  /**
   * 取候选标题的字号（后端算 —— 规则只在一处，§6.3⑬ 同一条纪律）。
   * 一次把「这条选题的标题 + 复用的标题 + 已出过的候选标题」都问掉，避免逐字请求。
   */
  const loadTitleMetrics = useCallback(async (extraTitles: string[]) => {
    const style = activeSelection?.cover?.titleStyle || baseTitleStyle;
    if (!style) return;
    const titles = Array.from(new Set([
      String(activeTopic?.title || "").trim(),
      ...extraTitles.map(item => String(item || "").trim()),
    ].filter(Boolean))).slice(0, 12);
    if (titles.length === 0) return;
    try {
      const result = await requestCoverTitleMetrics({ titles, titleStyle: style });
      setTitleMetrics(Array.isArray(result?.items) ? result.items : []);
    } catch {
      // 算不出来只是预览字号不准，不该打断出封面这条主流程。
      setTitleMetrics([]);
    }
  }, [activeSelection, baseTitleStyle, activeTopic]);

  /**
   * 一类（标准模板类）的出图提示词：**让模型在模板上直接做图片编辑**，产出一张新图。
   *
   * 用户口径（2026-09-24 纠正）：标准模板类**也要调生图模型** —— 固定的是人像与背景，
   * 每期只换标题，而「换标题」这件事由模型在图上完成（旧标题也被模型替换掉）。
   * 所以这一类**不做前端叠字**：文字是模型画在图里的。
   *
   * 把识别出的标题样式一并发给模型，是为了让每期标题风格保持一致（用户的原始要求）；
   * 字号按这一期标题长度算好给出**比例**，让它按可用空间自己收。
   */
  const buildStandardCoverPrompt = (title: string) => {
    const style = baseTitleStyle;
    const metrics = titleMetrics.find(item => item.title === title);
    const lines = [
      "以这张封面模板为参考图，重新生成一张封面：",
      "- 人物、背景、版式、色调与标题的字体风格严格保持不变；",
      "- 把封面上的标题文字替换成下面这一条，**不要保留模板上原有的标题文字**；",
      "- 标题的位置、颜色与分行方式跟模板保持一致，并按新标题的长度适当调整字号，不要溢出画面。",
      "",
      `新标题：${title}`,
    ];
    if (style?.fontFamily) lines.push(`标题字体风格：${style.fontFamily}`);
    if (style?.colorDescription || style?.color) lines.push(`标题颜色：${style.colorDescription || style.color}`);
    if (style?.position) {
      lines.push(`标题位置：${{ top: "顶部", center: "居中", bottom: "底部" }[style.position] || style.position}`);
    }
    if (style?.maxLines) lines.push(`标题最多占 ${style.maxLines} 行`);
    if (metrics?.fontSizePx) {
      lines.push(`标题字号参考：约占画面宽度的 ${Math.round((metrics.fontSizePx / TITLE_CANVAS_WIDTH) * 100)}%`);
    }
    return lines.join("\n");
  };

  /** 把标题以选定的样式叠加到封面上（纯 CSS，不依赖后端出字——模型写字会写成乱码）。 */
  const coverTitleStyle = activeSelection?.cover?.titleStyle || coverPlan?.titleStyle || baseTitleStyle;
  const overlayTitle = String(reuseTitles[0] || activeTopic?.title || "").trim();

  /**
   * 候选上的**叠字**文字。
   *
   * 二/三类的生成图里没有文字（提示词明确要求「不要写任何文字」），所以标题由前端叠；
   * 一类相反 —— 标题是**模型画在图里**的（在模板上做图片编辑、连旧标题一起替换），
   * 所以这一类绝不能再叠一次，否则又是两条标题。
   */
  const overlayTextFor = (candidate: CoverCandidate) => (
    String(candidate.tier || "") === "standard" ? "" : overlayTitle
  );

  /** 后端算好的字号（取不到就退回模板基准，保持预览可读）。 */
  const fontSizeFor = (text: string) => {
    const hit = titleMetrics.find(item => item.title === text);
    return hit?.fontSizePx || coverTitleStyle?.fontSizePx || 48;
  };

  // 切选题 / 换基底 / 换类型后，重新问一次字号，并同步逐条的标题草稿。
  useEffect(() => {
    setPerTopicTitle(String(activeTopic?.title || reuseTitles[0] || "").trim());
    setPerTopicBackgroundPrompt("");
    setPerTopicExpression("");
    const style = activeSelection?.cover?.titleStyle || baseTitleStyle;
    if (!style) {
      setTitleMetrics([]);
      return;
    }
    loadTitleMetrics([
      ...reuseTitles,
      ...(activeSelection?.cover?.candidates || []).map(item => item.title),
    ]);
  }, [activeTopic?.id, reuseTitles, baseTitleStyle, activeSelection, loadTitleMetrics]);

  // ── 3.2 发布文案 ──────────────────────────────────────────────────────────
  const loadPublishCopy = async () => {
    if (!activeTopic) return;
    setCopyLoading(true);
    setError("");
    try {
      const result = await requestPublishCopy({
        customerId,
        topic: {
          topicId: activeTopicId,
          title: String(activeTopic.title || ""),
          script: selectedScript,
          categoryName: String(activeTopic.content?.categoryName || ""),
          subcategoryName: String(activeTopic.content?.subcategoryName || ""),
        },
        // ★ 复用：标题与 3s 直接来自内容生成页，不重跑模型。
        reuseTitles,
        reuseThreeSeconds,
        accountTags: Object.values(accountConfirmed).filter(Boolean),
      });
      setCopyResult(result.publishCopy);
      await persist(activeTopicId, {
        publishCopy: { items: result.publishCopy.items, selected: selectionDrafts.get(activeTopicId)?.publishCopy?.selected || [] },
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "发布文案生成失败");
    } finally {
      setCopyLoading(false);
    }
  };

  // ── 3.3 发布标签 ──────────────────────────────────────────────────────────
  const loadAccountTags = async () => {
    setAccountTagsLoading(true);
    setError("");
    try {
      const result = await requestAccountTags({ customerId });
      // ⚠️ 结果可能是空的（Agent 没产出 / 老数据为 null）。原来直接
      //    `setAccountTags(result.accountTags)`，拿到 undefined 后渲染层读 `.angles` 就整页崩。
      //    空结果必须**如实提示**而不是把状态写成 undefined。
      if (!result?.accountTags?.angles?.length) {
        setError("账号标签这次没有生成出候选，请重试或先补齐账号定位信息。");
        return;
      }
      setAccountTags(result.accountTags);
      setAccountConfirmed(prev => {
        const next = { ...prev };
        // 没确认过的角度默认取第一个候选（用户仍可改），确认过的保留。
        for (const angle of result.accountTags.angles) {
          if (!next[angle.key]) next[angle.key] = angle.candidates[0] || "";
        }
        return next;
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "账号标签生成失败");
    } finally {
      setAccountTagsLoading(false);
    }
  };

  const confirmAccountTags = async () => {
    if (!accountTags) return;
    try {
      const saved = await saveAccountTags({
        customerId,
        customerName: String(activeTask?.customerName || ""),
        angleGroups: accountTags.angles,
        confirmed: {
          track: accountConfirmed.track || "",
          painPoint: accountConfirmed.painPoint || "",
          positioning: accountConfirmed.positioning || "",
        },
        referenceTags: accountTags.referenceTags,
        summary: accountTags.summary,
      });
      setAccountTags(saved);
      setMessage("账号标签库已确认保存（之后每一轮发布都复用它）");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "账号标签保存失败");
    }
  };

  const loadTopicTags = async () => {
    if (!activeTopic) return;
    setTopicTagsLoading(true);
    setError("");
    try {
      const availableSubcategories = String(activeTopic.content?.subcategoryName || "")
        .split(/[、,，\s]+/).filter(Boolean);
      const result = await requestTopicTags({
        customerId,
        topic: {
          topicId: activeTopicId,
          title: String(activeTopic.title || ""),
          script: selectedScript,
          categoryName: String(activeTopic.content?.categoryName || ""),
          subcategoryName: String(activeTopic.content?.subcategoryName || ""),
          availableSubcategories,
        },
      });
      setTopicTags(result.topicTags);
      await persist(activeTopicId, {
        topicTags: { groups: result.topicTags.groups, selected: result.topicTags.tags, missing: result.topicTags.missing },
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "选题标签生成失败");
    } finally {
      setTopicTagsLoading(false);
    }
  };

  // ── 导出 / 核查 ───────────────────────────────────────────────────────────
  const readPendingDraftItems = async (allowCache = true) => {
    const scope = { customerId, taskId: String(activeTask?._id || ""), topics: selectedTopics };
    try {
      const params = new URLSearchParams();
      if (scope.customerId) params.set("customerId", scope.customerId);
      if (scope.taskId) params.set("taskId", scope.taskId);
      const response = await fetchWithRetry(apiUrl(`/api/final-drafts?${params}`));
      const data = await response.json();
      if (!response.ok || data?.success === false) throw new Error(data?.error || "读取保存记录失败");
      const list = Array.isArray(data?.items) ? data.items : [];
      if (list.length > 0 || !allowCache) return filterExportDrafts(list, scope);
    } catch (error) {
      if (!allowCache) throw error;
      // 回落到浏览器缓存
    }
    return filterExportDrafts(readCachedFinalDrafts(), scope);
  };

  const exportAll = async (format: "feishu" | "bitable", block?: DraftExportBlock) => {
    setExporting(format);
    setError("");
    try {
      await selectionDrafts.flush();
      const items = block
        ? [pickDraftExportBlock({
          topic: { id: activeTopicId, title: activeTopic?.title || "", shareLink: activeTopic?.link || activeTopic?.shareLink || "" },
          customerId,
          taskId: String(activeTask?._id || ""),
          taskInfo: activeTask ? { id: String(activeTask._id || ""), customerName: activeTask.customerName, platformName: activeTask.platformName } : null,
          publishWarehouse: buildPublishPayload(),
        }, block)]
        : (await readPendingDraftItems()).map(item => withCurrentPublishSelection(item, selectionDrafts.get(String(item.topic?.id || "")), accountConfirmed));
      if (block && !hasDraftExportContent(items[0], block)) throw new Error("请先在当前选题、本块中选中要导出的内容。");
      if (items.length === 0) throw new Error("本批暂无已保存文案，请在内容生成页保存；只需要封面、发布文案或标签时，可直接使用各块的导出按钮。");
      if (format === "feishu") {
        const response = await fetchWithRetry(apiUrl("/api/export/feishu"), {
          method: "POST",
          retries: 0,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentName: block
            ? `${activeTask?.customerName || "选题"} - ${TABS.find(tab => tab.id === block)?.label || "发布材料"} - ${compactTopicLabel(activeTopic?.title, 40)}`
            : `${activeTask?.customerName || "选题"} - 选题复盘`, items }),
        });
        const data = await parseApiError(response);
        setMessage(`已写入飞书文档${data?.documentUrl ? `：${data.documentUrl}` : ""}`);
        if (data?.documentUrl) window.open(String(data.documentUrl), "_blank", "noopener,noreferrer");
      } else {
        const targetUrl = bitableUrl.trim();
        if (!/^https?:\/\/[^/]+\/base\/[^/?#]+/i.test(targetUrl)) throw new Error("请先在上方填写有效的飞书多维表格链接，或新建表格。");
        const response = await fetchWithRetry(apiUrl("/api/export/bitable"), {
          method: "POST",
          retries: 0,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetUrl,
            items,
            taskInfo: activeTask ? { customerName: String(activeTask.customerName || "") } : null,
          }),
        });
        const data = await parseApiError(response);
        setMessage(`已写入飞书多维表格${data?.bitableUrl ? `：${data.bitableUrl}` : ""}`);
        if (data?.bitableUrl) window.open(String(data.bitableUrl), "_blank", "noopener,noreferrer");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "导出失败");
    } finally {
      setExporting("");
    }
  };

  const createBitable = async () => {
    setExporting("create");
    setError("");
    try {
      const response = await fetchWithRetry(apiUrl("/api/export/bitable/create"), {
        method: "POST",
        retries: 0,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: bitableNewName.trim() || undefined }),
      });
      const data = await parseApiError(response);
      const url = String(data?.bitableUrl || "");
      updateBitableUrl(url);
      setMessage(`已创建多维表格${url ? `：${url}` : ""}`);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "创建多维表格失败");
    } finally {
      setExporting("");
    }
  };

  /**
   * 把当前选题的三块产出拼成最终编辑页要的负载。
   *
   * ⚠️ 只带 http(s) 封面外链，**不带 dataUrl**：出图可能回 base64，一张几 MB，
   *    塞进 sessionStorage 会把配额撑爆、连带别的草稿一起丢。只有内嵌图时用 `coverInline` 如实标注。
   * 标签口径与后端 `buildPublishBundle` 一致：账号恒定标签 + 选题标签，统一补 `#`。
   */
  const buildPublishPayload = () => buildPublishExport(selectionDrafts.get(activeTopicId), accountConfirmed);

  const goToFinalEditor = async () => {
    setError("");
    try {
      await selectionDrafts.flush();
      if (!activeTopic) throw new Error("请先选择一条选题。");
      const draft = (await readPendingDraftItems(false)).find(item => sameDraftTopic(item, activeTopic));
      if (!draft || !hasDraftExportContent(draft, "content")) {
        throw new Error("当前选题还没有已确认的文案，请返回内容生成页勾选并保存本条；只需发布材料时，可直接使用各块的导出按钮。");
      }
      const base = withCurrentPublishSelection(draft, selectionDrafts.get(activeTopicId), accountConfirmed);
      const index = workflowGroups.findIndex(group => group.shareLink === (activeTopic.link || activeTopic.shareLink));
      const payload = editorPayloadFromDraft(base, { id: workflowGroups[index]?.id || "", index: Math.max(0, index), total: workflowGroups.length });
      sessionStorage.setItem("finalDraftPayload", JSON.stringify(payload));
      navigate("/final-editor");
    } catch (requestError) {
      setError(`暂不能进入最终编辑：${requestError instanceof Error ? requestError.message : "交接保存失败，请重试"}`);
    }
  };

  const confirmComplete = async () => {
    try {
      await selectionDrafts.flush();
    } catch (requestError) {
      setError(`选择尚未保存，暂不能结束任务：${requestError instanceof Error ? requestError.message : "请重试保存"}`);
      return;
    }
    try { localStorage.removeItem(`bitableBinding:${String(activeTask?._id || "")}`); } catch { /* 忽略 */ }
    setTaskCompleteVisible(true);
    setTimeout(() => { window.location.href = "/"; }, 1800);
  };

  const coverCandidates = activeSelection?.cover?.candidates || [];
  const selectedCoverId = activeSelection?.cover?.selectedId || "";
  const selectedCover = coverCandidates.find(item => item.id === selectedCoverId) || null;

  /**
   * 选中那张的图片数据是否完整 —— 损坏时禁止改图/导出，并给出能照做的提示。
   *
   * ⚠️ 必须写在 `selectedCover` **之后**：写到前面就是 TDZ
   *    （`Cannot access 'selectedCover' before initialization`），整页掉进错误边界。
   *    而且 `npm run build` 与单测都拦不住 —— 这类错只有真渲染才暴露（已踩一次）。
   */
  const selectedCoverBroken = Boolean(
    selectedCover && !isCompleteImageDataUrl(selectedCover.image?.dataUrl || selectedCover.image?.url || ""),
  );

  /**
   * 删掉一张封面候选。
   *
   * ⚠️ 删掉的正好是**当前选中**那张时，必须同时改选（退到剩下的最后一张；一张不剩就清空）——
   *    否则「已选」会指向一个已经不存在的候选，后续改图/导出都会拿着空引用去跑。
   *    这条在报告列表那边踩过（HANDOFF §6.5㉙）。
   * 单击删除 + in-flight 守卫（与项目里其它列表删除同一套 UX，不弹二次确认）。
   */
  const removeCoverCandidate = async (candidateId: string) => {
    if (!candidateId || coverDeletingId) return;
    const remaining = coverCandidates.filter(item => item.id !== candidateId);
    const nextSelectedId = selectedCoverId === candidateId
      ? (remaining[remaining.length - 1]?.id || "")
      : selectedCoverId;
    setCoverDeletingId(candidateId);
    setError("");
    try {
      await persist(activeTopicId, {
        cover: { selectedId: nextSelectedId, candidates: remaining, titleStyle: coverTitleStyle || null },
      });
      // 对话记录跟着清掉：候选都没了，留着那串调整记录只会让人以为还能接着改。
      setCoverChats(prev => {
        if (!prev[candidateId]) return prev;
        const next = { ...prev };
        delete next[candidateId];
        return next;
      });
      setMessage(remaining.length > 0 ? "已删除这张封面" : "已删除这张封面 —— 这条选题现在没有候选了");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除封面失败");
    } finally {
      setCoverDeletingId("");
    }
  };

  const copyItems = activeSelection?.publishCopy?.items || copyResult?.items || [];
  const copySelected = activeSelection?.publishCopy?.selected || [];

  const tagGroups = activeSelection?.topicTags?.groups || topicTags?.groups || [];
  // 上面的 optional chaining 已经兜住了 topicTags 为 null；这里再确认一遍 groups 是数组。
  const tagSelected = activeSelection?.topicTags?.selected || [];

  const confirmedAccountTagList = Object.values(accountConfirmed).filter(Boolean);

  // ── 3.1 的可复用积木 ────────────────────────────────────────────────────────
  // 两个 Agent（IP 形象照 / 个性化背景模板）在二、三类的层里都要用，所以抽成变量复用，
  // 别在两处各写一遍（写两遍迟早只改一处）。

  // ── 本页统一的视觉词表 ──────────────────────────────────────────────────────
  // 与全站同一套语言：白卡 + slate-200 边框 + rounded-xl；blue-600 只给主操作，
  // 其余一律 outline / ghost；选中态 = blue-50 + blue-400（与内容生成页一致）；状态一律圆点。
  // 要治的是「散、不工整、AI 味」：同款大蓝钮只留一个、粉彩 chip 清零、间距全部走 4 的倍数。
  const BTN_PRIMARY = "h-9 rounded-xl bg-blue-600 px-4 text-[13px] font-medium text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const BTN_PRIMARY_LG = "h-10 w-full rounded-xl bg-blue-600 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50";
  const BTN_MD = "h-9 rounded-xl border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const BTN_SM = "h-8 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 shadow-sm transition hover:border-slate-300 hover:text-slate-900 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
  const BTN_GHOST_SM = "h-8 rounded-lg px-2.5 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
  const CARD = "rounded-xl border border-slate-200 bg-white shadow-sm";
  const INPUT = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-[13px] transition placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";
  const INPUT_SM = "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs transition placeholder:text-slate-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100";
  const LABEL = "text-xs font-medium text-slate-600";
  const CHIP_ON = "border-blue-400 bg-blue-50 font-medium text-blue-700";
  const CHIP_OFF = "border-slate-200 bg-white text-slate-600 hover:border-slate-300";
  const SEG_WRAP = "inline-flex items-center rounded-xl border border-slate-200 bg-slate-100/70 p-1";
  const SEG_ON = "bg-white font-medium text-slate-900 shadow-sm";
  const SEG_OFF = "text-slate-500 hover:text-slate-800";
  const EMPTY_BOX = "rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-[13px] text-slate-400";

  /** 上传一张图 → 视觉模型识别标题样式（三类共用的一步）。 */
  const recognizeBlock = (image: { url: string; dataUrl: string } | null, onPick: (file: File) => void, label: string, hint: string) => (
    <div className="space-y-2">
      <UploadDropzone label={label} hint={hint} image={image} onPick={onPick} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" className={BTN_SM} disabled={recognizeLoading || !image} onClick={() => runRecognize(image)}>
          {recognizeLoading ? "识别中…" : "识别标题样式"}
        </Button>
        {image && (
          <Button
            variant="ghost"
            className={BTN_GHOST_SM}
            onClick={() => { setBaseSourceImage(null); setBaseAnalysis(null); setBaseTitleStyle(null); setRecognizedStyle(null); }}
          >
            移除
          </Button>
        )}
      </div>
    </div>
  );

  /** 识别结果 + 一句话改样式的话框。 */
  const titleStyleBlock = (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={LABEL}>标题样式</span>
        {/* 色块 = 颜色，一眼看到；没有样式就全是「待识别」的浅灰字，不用再写一句提示。
            悬浮给的是模型**原话** —— 它可能说「白色、橙色，无描边」，而这里只能显示一个色块。 */}
        {baseTitleStyle?.color && (
          <span
            className="h-3.5 w-3.5 rounded border border-slate-200"
            style={{ backgroundColor: baseTitleStyle.color }}
            title={baseTitleStyle.colorDescription || baseTitleStyle.color}
          />
        )}
        <span className="text-[11px] text-slate-400">可一句话改</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
        {[
          ["字体", baseTitleStyle?.fontFamily],
          ["位置", { top: "上", center: "中", bottom: "下" }[baseTitleStyle?.position || "bottom"]],
          ["字号", `${baseTitleStyle?.fontSizePx ?? 64}px`],
          ["下限", `${baseTitleStyle?.minFontSizePx ?? 36}px`],
          ["行数", String(baseTitleStyle?.maxLines ?? 2)],
        ].map(([key, value]) => (
          <span key={key}>
            <span className="text-slate-400">{key}</span>{" "}
            <span className="font-medium text-slate-700">{value || "待识别"}</span>
          </span>
        ))}
      </div>
      {baseTitleStyle?.note && <div className="truncate text-[11px] text-slate-400" title={baseTitleStyle.note}>{baseTitleStyle.note}</div>}
      {styleChat.length > 0 && (
        <div className="space-y-1">
          {styleChat.slice(-4).map((item, index) => (
            <div
              key={`${item.role}-${index}`}
              className={`rounded-lg px-2.5 py-1.5 text-[11px] leading-4 ${
                item.role === "user" ? "ml-6 bg-slate-100 text-slate-700" : "mr-6 bg-slate-50 text-slate-500"
              }`}
            >
              {item.text}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          value={styleInput}
          onChange={event => setStyleInput(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); runStyleRefine(); } }}
          placeholder="一句话改样式，如「字号大一点、金色描边」"
          className={`min-w-[200px] flex-1 ${INPUT_SM}`}
        />
        <Button
          variant="outline"
          className={BTN_SM}
          disabled={styleLoading || !styleInput.trim()}
          onClick={runStyleRefine}
        >
          {styleLoading ? "调整中…" : "让它改"}
        </Button>
      </div>
    </div>
  );

  /** IP 形象照（可复用 Agent）。 */
  const portraitBlock = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LABEL}>IP 形象照</span>
        <span className="text-[11px] text-slate-400" title="穿着/场景取自账号规划的内容定位与职业，表情/动作取自人设定位；出图是唯一花钱的一步，确认提示词才触发">
          确认提示词后才出图
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className={BTN_SM} disabled={portraitLoading} onClick={runPortraitPlan}>
          {portraitLoading ? "生成中…" : "生成提示词建议"}
        </Button>
        <label className={`inline-flex cursor-pointer items-center ${BTN_SM}`}>
          参考照片
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0] || null;
              event.target.value = "";
              handleBaseImageUpload(file, setBasePortraitImage);
            }}
          />
        </label>
      </div>
      {/* 有图就给缩略图，没有就给一个占位格 —— 用看得见的东西表达「有没有」。 */}
      <div className="flex items-center gap-2">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {basePortraitImage ? (
            <img
              src={basePortraitImage.url || basePortraitImage.dataUrl}
              alt="IP 人像"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[11px] text-slate-300">人像</span>
          )}
        </div>
        <div className="min-w-0 flex-1 truncate text-[11px] text-slate-400" title={basePortraitBasis || ""}>
          {basePortraitBasis || "还没生成提示词"}
        </div>
      </div>
      <textarea
        value={basePortraitPrompt}
        onChange={event => setBasePortraitPrompt(event.target.value)}
        rows={3}
        placeholder="形象照提示词，可改"
        className={`w-full resize-none leading-5 ${INPUT_SM}`}
      />
      <Button
        variant="outline"
        className={`w-full ${BTN_SM}`}
        disabled={baseImageLoading === "portrait" || !basePortraitPrompt.trim()}
        onClick={() => makeBaseImage("portrait")}
      >
        {baseImageLoading === "portrait" ? "出图中…（较慢）" : "生成形象照"}
      </Button>
    </div>
  );

  /** 个性化背景模板（可复用 Agent）：上传对标封面 → 拆解 → 生成模板。 */
  const backgroundBlock = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={LABEL}>背景风格模板</span>
        <span className="text-[11px] text-slate-400" title="拆出对标封面的画风 / 元素 / 排版 / 视觉风格，再模仿生成自家的模板，并空出标题位与人像位的留白">
          拆解对标 → 生成留白模板
        </span>
      </div>
      {recognizeBlock(
        baseSourceImage,
        file => handleBaseImageUpload(file, image => { setBaseSourceImage(image); setBaseAnalysis(null); }),
        "上传对标封面",
        "拖入或点击选择",
      )}
      {/* 拆解结果：灰标签 + 深值，一行扫完，不再包一层 chip。 */}
      {baseAnalysis && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
          {[
            ["画风", baseAnalysis.artStyle],
            ["元素", baseAnalysis.elements],
            ["排版", baseAnalysis.layout],
            ["视觉", baseAnalysis.visualStyle],
            ["留白", baseAnalysis.reservedAreas.length > 0 ? baseAnalysis.reservedAreas.join("；") : ""],
          ].map(([label, value]) => (
            <span key={label} className="max-w-full truncate" title={String(value || "待人工补充")}>
              <span className="text-slate-400">{label}</span>{" "}
              <span className="font-medium text-slate-700">{value || "待补充"}</span>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {baseBackgroundTemplate ? (
            <img
              src={baseBackgroundTemplate.url || baseBackgroundTemplate.dataUrl}
              alt="背景风格模板"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center text-[11px] text-slate-300">模板</span>
          )}
        </div>
        <div className="min-w-0 flex-1 text-[11px] text-slate-400">
          {baseBackgroundTemplate ? "模板已生成" : "还没生成背景模板"}
        </div>
      </div>
      <textarea
        value={baseBackgroundPrompt}
        onChange={event => setBaseBackgroundPrompt(event.target.value)}
        rows={3}
        placeholder="背景模板提示词，可改"
        className={`w-full resize-none leading-5 ${INPUT_SM}`}
      />
      <Button
        variant="outline"
        className={`w-full ${BTN_SM}`}
        disabled={baseImageLoading === "backgroundTemplate" || !baseBackgroundPrompt.trim()}
        onClick={() => makeBaseImage("backgroundTemplate")}
      >
        {baseImageLoading === "backgroundTemplate" ? "出图中…（较慢）" : "生成背景模板"}
      </Button>
    </div>
  );

  const activeTierIds = (tier: CoverTier | null) => {
    if (!tier) return [];
    const list: string[] = [];
    if (tier.needsPortrait) list.push("IP 形象照");
    if (tier.needsBackgroundTemplate) list.push("个性化背景模板");
    return list;
  };

  /**
   * 底图上是不是**自带标题文字**。   *
   * 一类只往图上叠新标题，没有任何一步会擦掉原文字 —— 底图自带标题时会叠成两条
   * （2026-09-23 用户实测）。识别结果里读到字体/颜色描述/备注，就说明模型在图上看
   * 到了标题文字，据此提示换底图。
   */
  const templateHasBakedTitle = Boolean(
    activeTier?.id === "standard"
    && baseAnalysis
    && (baseTitleStyle?.fontFamily || baseTitleStyle?.colorDescription || baseTitleStyle?.note),
  );

  /**
   * 对话式改图：把「当前选中的这张封面」交给模型重新出图，只改用户提到的那部分。
   *
   * 关键取舍：改完的结果**作为新的一版候选追加**，原来那版保留。
   * 出图是不可逆的（每次约 50s、每次都花钱），覆盖掉上一版等于让用户没法回退比较。
   * 对话记录挂在新候选 id 上，所以继续改就是在最新那一版上接着改。
   */
  const runCoverRefine = async () => {
    const instruction = coverChatInput.trim();
    if (!instruction) return;
    const candidate = selectedCover;
    if (!candidate) {
      setError("先在候选里选中一张，再告诉我要改什么");
      return;
    }
    const sourceId = candidate.id;
    const sourceHistory = (coverChats[sourceId] || []).filter(item => item.role === "user").map(item => item.text);
    setCoverChatLoading(sourceId);
    setError("");
    setCoverChatInput("");
    setCoverChats(prev => ({ ...prev, [sourceId]: [...(prev[sourceId] || []), { role: "user", text: instruction }] }));

    const appendReply = (id: string, text: string) => {
      setCoverChats(prev => ({ ...prev, [id]: [...(prev[id] || []), { role: "model", text }] }));
    };

    try {
      const result = await refineCoverImage({
        image: { url: candidate.image?.url || "", dataUrl: candidate.image?.dataUrl || "" },
        instruction,
        history: sourceHistory,
        title: candidate.title,
        titleStyle: coverTitleStyle,
      });
      const rawImage = result.images?.[0];
      if (!rawImage) throw new Error("改图接口没有返回图片");
      const image = { url: rawImage.url || "", dataUrl: await downscaleDataUrl(rawImage.dataUrl || rawImage.url || "") };
      const existing = activeSelection?.cover?.candidates || [];
      const nextId = `cover-${existing.length + 1}`;
      const nextCandidates = [
        ...existing,
        {
          id: nextId,
          title: `${candidate.title} · 改${existing.length}`,
          keywords: [],
          prompt: instruction,
          image: { url: image.url || "", dataUrl: image.dataUrl || "" },
          // 类型跟着原候选走 —— 它决定候选上标「几类」，也决定还会不会被前端叠字。
          tier: candidate.tier,
        },
      ];
      await persist(activeTopicId, {
        cover: { selectedId: nextId, candidates: nextCandidates, titleStyle: coverTitleStyle || null },
      });
      // 记录搬到新版本上，继续改就是接着这一版改。
      setCoverChats(prev => ({
        ...prev,
        [nextId]: [
          ...(prev[sourceId] || []),
          { role: "model", text: `已按「${instruction}」重新出图，作为新的一版（上一版仍保留在候选里）` },
        ],
      }));
      setMessage("改图完成，已作为新的一版候选");
    } catch (requestError) {
      appendReply(sourceId, `没改成：${requestError instanceof Error ? requestError.message : "请求失败"}`);
    } finally {
      setCoverChatLoading("");
    }
  };

  /**
   * 把「底图 + 标题」合成成一张真正的 PNG 下载下来。
   *
   * 为什么不只给预览：预览是 DOM 叠字，用户拿不到文件；而这个模块的交付物就是**一张封面图**。
   * 合成口径与预览一致：字号按 1080 宽的等比缩放到实际图宽，位置/颜色都取同一份 titleStyle。
   *
   * ⚠️ 底图是外链时会走 canvas 的跨域限制：对方不发 CORS 头的话 `toDataURL` 会抛错
   *    （画布被污染）。这种情况如实报错并提示换成本地图 / 保存到本地，不要假装成功。
   */
  const downloadCover = async (candidate: CoverCandidate) => {
    const src = candidate.image?.dataUrl || candidate.image?.url || "";
    if (!src) {
      setError("这张候选没有图片，无法导出");
      return;
    }
    const text = overlayTextFor(candidate);
    const style = coverTitleStyle;
    setError("");
    try {
      await selectionDrafts.flush();
      const image = new Image();
      // dataUrl 不需要也不该设这个；外链则需要，否则画布会被污染。
      if (!src.startsWith("data:")) image.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("底图加载失败（外链可能不允许跨域取图）"));
        image.src = src;
      });

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || TITLE_CANVAS_WIDTH;
      canvas.height = image.naturalHeight || Math.round(TITLE_CANVAS_WIDTH * 4 / 3);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("当前浏览器不支持画布导出");

      ctx.drawImage(image, 0, 0);

      if (text) {
        // 预览里字号是按 1080 宽的设计稿算的，这里等比放到实际图宽。
        const scale = canvas.width / TITLE_CANVAS_WIDTH;
        const size = Math.max(12, Math.round(fontSizeFor(text) * scale));
        const maxLines = style?.maxLines ?? 2;
        ctx.font = `bold ${size}px ${style?.fontFamily ? `"${style.fontFamily}", ` : ""}sans-serif`;
        ctx.fillStyle = style?.color || "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        const lines = wrapCanvasText(ctx, text, canvas.width * 0.9, maxLines);
        const lineHeight = size * 1.15;
        const blockHeight = lines.length * lineHeight;
        let y = style?.position === "top"
          ? size * 1.25
          : style?.position === "center"
            ? (canvas.height - blockHeight) / 2 + size * 0.85
            : canvas.height - blockHeight + size * 0.5;
        for (const line of lines) {
          ctx.fillText(line, canvas.width / 2, y);
          y += lineHeight;
        }
      }

      const anchor = document.createElement("a");
      anchor.href = canvas.toDataURL("image/png");
      // 文件名优先用候选自己的标题：一类的候选 title 就是那一期的标题（文字已由模型画进图里），
      // 二/三类的 title 是「封面 N」这种标签，叠字文字更贴切。
      anchor.download = `${(candidate.title || text || "封面").slice(0, 40)}.png`;
      anchor.click();
      setMessage(text ? "已导出这张封面（底图 + 标题，PNG）" : "已导出这张封面（PNG）");
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : "导出失败"}。`
        + "可以先把底图存到本地再上传（本地文件不受跨域限制）。",
      );
    }
  };

  return (
    <div className="min-h-screen bg-[#f5f7fb]">
      {/* 页头与其他页面同一套：白底 + slate-200 分割线 + 左标题右操作。
          容器收窄到 1200：原来 1500 的内容被拉成一条长线，是「散」的主要来源。 */}
      <header className="border-b border-slate-200/80 bg-white/80 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto max-w-[1200px]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-slate-950">发布仓</h1>
              <p className="mt-0.5 text-[13px] text-slate-500">
                为每条选题确认封面、文案与标签，确认完进最终文案页。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className={BTN_MD} onClick={() => navigate("/content")}>
                返回内容生成
              </Button>
            </div>
          </div>
          {!customerId && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs leading-5 text-amber-700">
              没有读到客户信息，发布仓依赖客户选题库，请从「今日选题」正常进入。
            </div>
          )}
        </div>
      </header>

        {/* 统一节奏：子块间距全部 16px（space-y-4），不再各处自定义 mb。 */}
      <main className="mx-auto max-w-[1200px] space-y-4 px-5 py-5 sm:px-8">
        {error && (
          <div className="rounded-lg border border-red-200/70 bg-red-50 px-3.5 py-2.5 text-xs leading-5 text-red-700">{error}</div>
        )}
        {message && (
          <div className="rounded-lg border border-emerald-200/70 bg-emerald-50 px-3.5 py-2.5 text-xs leading-5 text-emerald-700">{message}</div>
        )}

        {/* 选题切换：原来是一整张卡（标题 + 内容区 ~110px），现在压成一行 chip。 */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="shrink-0 text-xs font-semibold text-slate-400">
            选题 {selectedTopics.length > 0 ? `${activeTopicIndex + 1}/${selectedTopics.length}` : "—"}
          </span>
          {selectedTopics.length === 0 ? (
            <span className="text-xs text-slate-400">没有读到选题，请先在内容生成页确认。</span>
          ) : selectedTopics.map((topic, index) => (
            <button
              key={String(topic.id || index)}
              type="button"
              onClick={() => {
                setActiveTopicIndex(index);
                setCoverPlan(null);
                // 提示词是**按选题**写的，切走必须清掉 —— 否则它的内容与当前选题无关，
                // 而「确认提示词并生成封面」是唯一花钱的按钮，带着上一条的提示词出图等于白花钱。
                // （参考照片不跟着清：它是**按客户**的 IP 形象照，同一客户下本来就该复用。）
                setCopyResult(null);
                setTopicTags(null);
              }}
              className={`max-w-[260px] truncate rounded-lg border px-3 py-1.5 text-xs transition ${
                index === activeTopicIndex
                  ? "border-blue-400 bg-blue-50 font-medium text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {topic.title || "（无标题）"}
            </button>
          ))}
          {(saveStatus.saving.length > 0 || loadingSelections) && (
            <span role="status" className="ml-auto text-xs text-slate-400">{saveStatus.saving.length > 0 ? "保存中…" : "读取上次进度…"}</span>
          )}
        </div>

        {(Object.keys(saveStatus.errors).length > 0 || saveStatus.cacheError) && (
          <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {Object.keys(saveStatus.errors).length > 0 && <span>
              {`有 ${Object.keys(saveStatus.errors).length} 条选题的选择未保存，当前勾选已保留。${Object.values(saveStatus.errors)[0]}`}
            </span>}
            {saveStatus.cacheError && <span>{saveStatus.cacheError}</span>}
            {Object.keys(saveStatus.errors).length > 0 && (
              <Button variant="outline" className="h-8 text-xs" disabled={saveStatus.saving.length > 0}
                onClick={() => { void selectionDrafts.flush().catch(() => { /* Retain retry notice. */ }); }}>
                重试保存
              </Button>
            )}
          </div>
        )}

        {/* 三块主页签：分段控件，只留编号 + 名称（原来的灰字说明挪进各页自己的空态里）。 */}
        <div className={`mb-4 ${SEG_WRAP}`}>
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-4 py-1.5 text-sm transition ${activeTab === tab.id ? SEG_ON : SEG_OFF}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── 3.1 封面 ─────────────────────────────────────────────────────── */}
        {/* 三种类型各一层；两个可复用 Agent（IP 形象照 / 个性化背景模板）在二、三类的层里按需引用。
            类型在**保存基底时**才落库，进来只是看一下。 */}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3">
          <span className="mr-auto text-xs text-slate-600">当前选题 · {TABS.find(tab => tab.id === activeTab)?.label} · 仅导出已选内容</span>
          <Button variant="outline" className={BTN_SM} disabled={Boolean(exporting) || !activeTopic} onClick={() => exportAll("feishu", activeTab)}>
            导出本块到飞书文档
          </Button>
          <Button variant="outline" className={BTN_SM} disabled={Boolean(exporting) || !activeTopic} onClick={() => exportAll("bitable", activeTab)}>
            导出本块到多维表格
          </Button>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 border-t border-slate-100 pt-2">
            <span className="text-xs text-slate-500">本任务导出表格</span>
            <input value={bitableUrl} onChange={event => updateBitableUrl(event.target.value)} placeholder="粘贴已有表格 URL" className={`min-w-0 flex-1 ${INPUT_SM}`} />
            <input value={bitableNewName} onChange={event => setBitableNewName(event.target.value)} placeholder="表格名称（可选）" className={`w-40 max-w-full ${INPUT_SM}`} />
            <Button variant="outline" className={BTN_SM} disabled={Boolean(exporting)} onClick={createBitable}>
              {exporting === "create" ? "创建中…" : "新建表格"}
            </Button>
          </div>
        </div>

        {activeTab === "cover" && (
          <div className="space-y-3">
            {/* 类型页签：分段控件。原来每个页签下面还挂一行灰字说明，收进下面的单行说明里。 */}
            <div className="flex flex-wrap items-center gap-3">
              <div className={SEG_WRAP}>
                {coverTiers.map(tier => {
                  const selected = coverSubTab === tier.id;
                  const isBase = coverBase?.tier === tier.id;
                  return (
                    <button
                      key={tier.id}
                      type="button"
                      onClick={() => setCoverSubTab(tier.id)}
                      className={`flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-sm transition ${selected ? SEG_ON : SEG_OFF}`}
                    >
                      {tier.code}、{tier.label}
                      {/* 绿点 = 这个类型已是保存过的基底，用颜色代替一行文字 */}
                      {isBase && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
                    </button>
                  );
                })}
              </div>
              {coverTiers.length === 0 && <span className="text-xs text-slate-400">类型定义没读到，检查接口后刷新。</span>}
              {coverBaseLoading && <span className="text-xs text-slate-400">读取上次的封面基底…</span>}
            </div>

            {/* 选中类型的一行说明。原来是整张说明卡；summary / note / 使用节点全是「规则」，
                挪进 title 悬浮，可见的只留：类型名、用到什么、基底状态。 */}
            {activeTier && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span
                  className="font-semibold text-slate-700 underline decoration-dotted decoration-slate-300 underline-offset-4"
                  title={`${activeTier.label}：${activeTier.summary}。${activeTier.note}。使用节点：${activeTier.whenToUse}`}
                >
                  {activeTier.label}
                </span>
                <span className="flex items-center gap-1">
                  {activeTierIds(activeTier).length > 0 ? (
                    <>
                      <span className="text-slate-400">用到</span>
                      {activeTierIds(activeTier).map(name => (
                        <span key={name} className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-600">{name}</span>
                      ))}
                    </>
                  ) : (
                    <span className="text-slate-400">不需要额外素材</span>
                  )}
                </span>
                {activeTier.needsPortrait && !activeTier.canGeneratePortrait && (
                  <span className="text-slate-400">人像沿用已有那张</span>
                )}
                {coverBase?.tier === activeTier.id
                  ? <span className="inline-flex items-center gap-1 font-medium text-emerald-600"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />已是当前基底</span>
                  : <span className="text-slate-400">保存基底后才切到这一类</span>}
              </div>
            )}

            {activeTier ? (
              <div className="space-y-3">

                {/* 素材区：两个 Agent 并排（原来竖着叠成一面墙），保存 / 清空收进标题行，
                    有没有素材用缩略图 + 状态点表达，不再靠一行「还缺 X」的文字。 */}
                <Card className={CARD}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm font-semibold text-slate-900">封面基底</CardTitle>
                      <div className="flex items-center gap-2">
                        {coverBase?.updatedAt && (
                          <span className="text-xs text-slate-400">上次保存 {formatMetTime(coverBase.updatedAt)}</span>
                        )}
                        <Button variant="outline" className="h-8 rounded-lg px-3 text-xs" disabled={coverBaseSaving} onClick={clearCoverBase}>
                          清空重来
                        </Button>
                        <Button
                          className="h-8 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-55"
                          disabled={coverBaseSaving}
                          onClick={() => persistCoverBase()}
                        >
                          {coverBaseSaving ? "保存中…" : "保存为基底"}
                        </Button>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {activeTier.id === "standard" ? (
                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="rounded-xl border border-slate-200 p-3">
                          {recognizeBlock(
                            baseSourceImage,
                            file => handleBaseImageUpload(file, image => { setBaseSourceImage(image); setBaseAnalysis(null); }),
                            "上传固定封面模板",
                            "人像 + 背景固定下来的那张：可以带标题，出图时会被替换掉",
                          )}
                          {/* 一类是让模型**在模板上改标题**，所以模板带不带标题都行：
                              带标题反而更省事（模型照样式替换），不带就由它按样式加上。
                              之前这里写的是「请换一张不含标题的底图」，那是「前端叠字」那版
                              实现下的限制，改成出图之后就不成立了（2026-09-24 用户纠正）。 */}
                          {templateHasBakedTitle && (
                            <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-500">
                              这张模板上已经有标题文字，出图时会被<span className="font-semibold">替换</span>成这一期的标题
                              （样式沿用模板上的，也就是右边识别到的标题样式）。
                            </div>
                          )}
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">{titleStyleBlock}</div>
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="rounded-xl border border-slate-200 p-3">{backgroundBlock}</div>
                          <div className="rounded-xl border border-slate-200 p-3">{portraitBlock}</div>
                        </div>
                        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">{titleStyleBlock}</div>
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* 这一期出封面 */}
                <Card className={CARD}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm font-semibold text-slate-900">这一期出封面</CardTitle>
                      {/* 就绪度用颜色表达：绿点 = 齐了；缺什么就给几个琥珀色 chip，
                          不再写一句「还缺 X —— 先在上面补齐」重复上面 chip 已经说过的话。 */}
                      {coverReadiness.ok ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />素材齐了
                        </span>
                      ) : (
                        <span className="flex flex-wrap items-center gap-1">
                          {coverReadiness.missing.map(name => (
                            <span key={name} className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">缺 {name}</span>
                          ))}
                        </span>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <label className="text-xs font-semibold text-slate-600">这一期的标题</label>
                        <span className="text-[11px] text-slate-400">
                          {fontSizeFor(perTopicTitle)}px{titleMetrics.find(item => item.title === perTopicTitle)?.shrunk && " · 已收缩"}
                        </span>
                      </div>
                      <input
                        value={perTopicTitle}
                        onChange={event => setPerTopicTitle(event.target.value)}
                        placeholder="这一期要用的标题"
                        className={`mt-1.5 ${INPUT}`}
                      />
                      {reuseTitles.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {reuseTitles.map(item => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => setPerTopicTitle(item)}
                              className={`max-w-[260px] truncate rounded-lg border px-3 py-1.5 text-xs transition ${
                                perTopicTitle === item ? CHIP_ON : CHIP_OFF
                              }`}
                            >
                              {item}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {activeTier.perIssueFields.includes("backgroundPrompt") && (
                      <div>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <label className="text-xs font-semibold text-slate-600">这一期的背景</label>
                          <Button variant="outline" className="h-8 rounded-lg px-3 text-xs" disabled={coverLoading || !activeTopic} onClick={loadCoverPlan}>
                            {coverLoading ? "生成中…" : "按脚本建议"}
                          </Button>
                        </div>
                        <textarea
                          value={perTopicBackgroundPrompt}
                          onChange={event => setPerTopicBackgroundPrompt(event.target.value)}
                          rows={3}
                          placeholder="围绕脚本关键词的背景提示词"
                          className={`mt-1.5 ${INPUT} leading-5`}
                        />
                        {(coverPlan?.backgrounds || []).length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {(coverPlan?.backgrounds || []).map(background => (
                              <div key={background.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5">
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-xs font-medium text-slate-800">{background.title}</div>
                                  <div className="truncate text-[11px] text-slate-400" title={background.prompt}>{toPreview(background.prompt, 60)}</div>
                                </div>
                                <Button variant="outline" className="h-7 shrink-0 rounded-lg px-2.5 text-[11px]" onClick={() => setPerTopicBackgroundPrompt(background.prompt)}>
                                  用
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {activeTier.perIssueFields.includes("portraitExpression") && (
                      <div>
                        <label className="text-xs font-semibold text-slate-600">人像表情 / 动作</label>
                        <input
                          value={perTopicExpression}
                          onChange={event => setPerTopicExpression(event.target.value)}
                          placeholder="例如 惊讶并竖起一根手指"
                          className={`mt-1.5 ${INPUT}`}
                        />
                      </div>
                    )}

                    <Button
                      className={BTN_PRIMARY_LG}
                      disabled={!coverReadiness.ok || Boolean(coverImageLoading) || !perTopicTitle.trim()}
                      title={activeTier.id === "standard"
                        ? "把模板交给模型做图片编辑：替换标题、产出一张新图（这一步花钱）"
                        : "确认提示词后才出图（唯一花钱的一步）"}
                      onClick={() => {
                        if (activeTier.id === "standard") {
                          // 一类也要真的出图：模板当参考图，交给模型在图上替换标题。
                          // 候选的 title 存这一期的标题，方便分辨每张是哪一期出的。
                          makeCoverImage(buildStandardCoverPrompt(perTopicTitle), perTopicTitle.trim(), []);
                          return;
                        }
                        const parts = [
                          perTopicBackgroundPrompt.trim(),
                          perTopicExpression.trim() ? `人物表情与动作：${perTopicExpression.trim()}` : "",
                          "竖版 3:4 封面，不要写任何文字（标题由前端叠加）。",
                        ].filter(Boolean);
                        makeCoverImage(parts.join("\n"), `封面 ${coverCandidates.length + 1}`, []);
                      }}
                    >
                      {coverImageLoading ? "出图中…（较慢）" : "生成封面"}
                    </Button>
                    <p className="text-[11px] leading-5 text-slate-400">
                      {activeTier.id === "standard"
                        ? "这一步会调生图模型：在模板上替换标题、产出一张新图（唯一花钱的步骤）。"
                        : "这一步会调生图模型（唯一花钱的步骤）。"}
                    </p>
                  </CardContent>
                </Card>

                {/* 候选与标题叠加 */}
                <Card className={CARD}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <CardTitle className="text-sm font-semibold text-slate-900">
                        封面候选 <span className="text-slate-400">{coverCandidates.length}</span>
                      </CardTitle>
                      {/* 预览是 DOM 叠字，用户拿不到文件；这个模块的交付物是一张封面图，
                          所以给一个「导成 PNG」的出口（画布合成，口径与预览一致）。 */}
                      {selectedCover && (
                        <Button
                          variant="outline"
                          className={BTN_SM}
                          onClick={() => downloadCover(selectedCover)}
                          title="把选中的这张（底图 + 标题）合成成 PNG 下载"
                        >
                          导出这张封面
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {coverCandidates.length === 0 ? (
                      <p className={EMPTY_BOX}>
                        还没有封面
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {coverCandidates.map(candidate => {
                          const src = candidate.image?.dataUrl || candidate.image?.url || "";
                          const isSelected = candidate.id === selectedCoverId;
                          const label = overlayTextFor(candidate);
                          const candidateTier = coverTiers.find(item => item.id === String(candidate.tier || ""));
                          return (
                            <div
                              key={candidate.id}
                              className={`group relative overflow-hidden rounded-xl border transition ${isSelected ? "border-blue-400 ring-2 ring-blue-200" : "border-slate-200"}`}
                            >
                              {/* 删除放**左上角**：右上角被「已选」的勾占了，两个叠一起会互相盖住。
                                  单击即删 + in-flight 守卫（与项目里其它列表删除同一套 UX）。 */}
                              <button
                                type="button"
                                disabled={coverDeletingId === candidate.id}
                                onClick={() => removeCoverCandidate(candidate.id)}
                                title="删除这张封面候选"
                                className="absolute left-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900/55 text-white opacity-0 backdrop-blur-sm transition hover:bg-red-600 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-60"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                className="relative block w-full [container-type:inline-size]"
                                aria-pressed={isSelected}
                                onClick={() => selectImmediately(activeTopicId, { cover: { selectedId: candidate.id } })}
                              >
                                {src ? (
                                  <img src={src} alt={candidate.title} className="aspect-[3/4] w-full object-cover" />
                                ) : (
                                  <div className="flex aspect-[3/4] w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
                                    无图片
                                  </div>
                                )}
                                {/* 选中态直接盖在图上一个勾 —— 卡片本身也被蓝色描边包住，
                                    两处呼应就不用再写「已选」两个字。 */}
                                {isSelected && (
                                  <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-white shadow">
                                    <Check className="h-3 w-3" />
                                  </span>
                                )}
                                {/* 标题叠加：纯 CSS。让模型在图上写字会写成乱码，所以文字一律前端叠。 */}
                                {label && (
                                  <span
                                    className={`absolute inset-x-0 px-2 text-center font-bold leading-tight drop-shadow ${
                                      coverTitleStyle?.position === "top" ? "top-2" : coverTitleStyle?.position === "center" ? "top-1/2 -translate-y-1/2" : "bottom-2"
                                    }`}
                                    style={{
                                      // 颜色必须已经是**合法 CSS 值**（后端 normalizeCssColor 收敛过）：
                                      // 模型回的是「白色、橙色，无描边或阴影」这种描述，直接当 CSS 会被静默丢弃 → 变黑字。
                                      color: coverTitleStyle?.color || "#ffffff",
                                      // 后端的字号是按 1080 宽的竖版设计稿算的，所以这里换成**容器宽度百分比**（cqw），
                                      // 让它随缩略图一起缩放 —— 写死 px 会让预览严重失真。
                                      fontSize: `${(fontSizeFor(label) / TITLE_CANVAS_WIDTH) * 100}cqw`,
                                    }}
                                  >
                                    {label}
                                  </span>
                                )}
                              </button>
                              <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5">
                                <span className="truncate text-[11px] text-slate-500">{candidate.title}</span>
                                {/* 换类型后旧封面仍保留，标出它当时是哪一类 */}
                                {candidateTier && <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{candidateTier.code}类</span>}
                                {/* 图片数据被截断过（早期版本的存储上限 bug）——标出来，
                                    否则用户只会看到一个看不懂的「参考图无效」。 */}
                                {!isCompleteImageDataUrl(candidate.image?.dataUrl || candidate.image?.url || "") && (
                                  <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">图片已损坏</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* ── 对话改图 ────────────────────────────────────────────
                        以选中的那张为参考图重新出图，只改用户提到的那部分。
                        每次都会真的重新出图（实测约 50s、每次花钱），所以按钮有 in-flight 守卫，
                        且改完是**追加新的一版候选**、不覆盖上一版 —— 出图不可逆，得能回退比较。 */}
                    {selectedCover && (
                      <div className="space-y-2 border-t border-slate-100 pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={LABEL}>对话改图</span>
                          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                            每次都会重新出图 · 约 1 分钟 · 会花钱
                          </span>
                          <span className="text-[11px] text-slate-400">每次改动都会存成新的一版，旧版保留</span>
                        </div>
                        <div className="text-[11px] text-slate-400">正在改：{selectedCover.title}</div>
                        {selectedCoverBroken && (
                          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
                            这张封面的<span className="font-semibold">图片数据已损坏</span>
                            （早期版本的存储上限把图截断了，字节已经丢了、修不回来）。
                            拿它当参考图，出图网关只会回一句看不懂的「参考图无效」——
                            请换一张候选，或重新生成一张再改。
                          </div>
                        )}
                        {(coverChats[selectedCover.id] || []).length > 0 && (
                          <div className="space-y-1.5">
                            {(coverChats[selectedCover.id] || []).map((item, index) => (
                              <div
                                key={`${item.role}-${index}`}
                                className={`rounded-xl px-3 py-2 text-xs leading-5 ${
                                  item.role === "user" ? "ml-6 bg-blue-50 text-blue-900" : "mr-6 bg-slate-50 text-slate-600"
                                }`}
                              >
                                {item.text}
                              </div>
                            ))}
                          </div>
                        )}
                        {coverChatLoading === selectedCover.id && (
                          <div className="text-[11px] text-slate-400">正在重新出图…（约 1 分钟，别关页面）</div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          <input
                            value={coverChatInput}
                            onChange={event => setCoverChatInput(event.target.value)}
                            onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); runCoverRefine(); } }}
                            placeholder="用一句话说要改什么，例如「标题再大一点」「人物往右移」"
                            className={`min-w-[240px] flex-1 ${INPUT}`}
                          />
                          <Button
                            className={BTN_PRIMARY}
                            disabled={Boolean(coverChatLoading) || !coverChatInput.trim() || selectedCoverBroken}
                            onClick={runCoverRefine}
                          >
                            {coverChatLoading === selectedCover.id ? "改图中…" : "改图"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </div>
            ) : (
              /* 走到这里只有一种情况：封面类型没读到（接口失败）。原来这里还挂着
                 两个「独立板块」分支，但类型页签改成只切三个类型之后它们已经不可达，
                 留着就是死代码 —— 换成一句空态。 */
              <div className={EMPTY_BOX}>
                封面类型没读到，刷新重试。
              </div>
            )}
          </div>
        )}

        {/* ── 3.2 发布文案 ─────────────────────────────────────────────────── */}
        {activeTab === "copy" && (
          <Card className={CARD}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                {/* 原来标题下面还挂一段两行说明（金句 AI 生成 / 标题与 3s 复用已有结果）。
                    这段是**规则**不是**操作**，挪进 title + 各类的「复用已有 / AI 生成」小标签里，
                    正文只剩可选的卡片。 */}
                <CardTitle
                  className="text-sm font-semibold text-slate-900"
                  title="金句与互动由 AI 生成；标题与 3s 直接复用内容生成页已确认的结果，不会重跑一遍"
                >
                  发布文案
                </CardTitle>
                <Button
                  className="h-8 rounded-lg bg-slate-950 px-3 text-xs font-semibold text-white hover:bg-slate-800"
                  disabled={copyLoading || !activeTopic}
                  onClick={loadPublishCopy}
                >
                  {copyLoading ? "生成中…" : copyItems.length > 0 ? "重新生成" : "生成"}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {copyItems.length === 0 ? (
                <p className={EMPTY_BOX}>
                  还没有发布文案
                </p>
              ) : (
                <div className="grid gap-2.5 lg:grid-cols-2">
                  {copyItems.map(item => (
                    <div key={item.kind} className="rounded-xl border border-slate-200 px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-slate-800">{item.label}</span>
                        <span className={`rounded px-1.5 py-0.5 text-[11px] ${item.source === "reuse" ? "bg-slate-100 text-slate-500" : "bg-blue-50 text-blue-600"}`}>
                          {item.source === "reuse" ? "复用" : "AI"}
                        </span>
                        {item.options.length === 0 && <span className="text-[11px] text-amber-600">无内容</span>}
                      </div>
                      <div className="mt-1.5 space-y-1.5">
                        {item.options.map(option => {
                          const checked = copySelected.includes(option);
                          return (
                            <button
                              key={option}
                              type="button"
                              aria-pressed={checked}
                              onClick={() => selectImmediately(activeTopicId, current => ({
                                publishCopy: {
                                  items: current.publishCopy.items.length > 0 ? current.publishCopy.items : copyItems,
                                  selected: toggle(current.publishCopy.selected, option),
                                },
                              }))}
                              className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                                checked ? "border-blue-400 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
                              }`}
                            >
                              {/* 勾只在选中时出现：没勾 = 没选，不用再读文字 */}
                              <span className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${checked ? "border-blue-500 bg-blue-500 text-white" : "border-slate-300"}`}>
                                {checked && <Check className="h-2.5 w-2.5" />}
                              </span>
                              <span className="min-w-0 flex-1">{option}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── 3.3 发布标签 ─────────────────────────────────────────────────── */}
        {/* 各块可独立导出；标签页继续保留整批核查和导出入口。 */}
        {activeTab === "tags" && (
          <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card className={CARD}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  {/* 「三个角度各选 1 个、确认后长期复用」是规则，收进 title 悬浮 */}
                  <CardTitle
                    className="text-sm font-semibold text-slate-900"
                    title="三个角度各选 1 个，确认后作为账号恒定标签长期复用，不用每轮重选"
                  >
                    账号标签库
                  </CardTitle>
                  <Button variant="outline" className="h-8 rounded-lg px-3 text-xs" disabled={accountTagsLoading} onClick={loadAccountTags}>
                    {accountTagsLoading ? "生成中…" : accountTags ? "重新生成" : "生成"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {ACCOUNT_TAG_ANGLES.map(angle => {
                  // 先取出来再用：写成 `x || [].map(...)` 会让 `.map` 绑到 `[]` 上，
                  // 而且三元与 `||` 混在一起极易读错。派生值统一放使用它的 JSX 之前。
                  const candidates = (accountTags?.angles || []).find(item => item.key === angle.key)?.candidates || [];
                  return (
                    <div key={angle.key}>
                      <div className="text-xs font-semibold text-slate-600">{angle.label}</div>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {candidates.map(candidate => (
                          <button
                            key={candidate}
                            type="button"
                            onClick={() => setAccountConfirmed(prev => ({ ...prev, [angle.key]: candidate }))}
                            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                              accountConfirmed[angle.key] === candidate ? CHIP_ON : CHIP_OFF
                            }`}
                          >
                            {candidate}
                          </button>
                        ))}
                        {candidates.length === 0 && (
                          <span className="text-[11px] text-slate-400">还没生成候选</span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <Button
                  className="h-9 w-full rounded-lg bg-blue-600 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-600/40 disabled:opacity-70"
                  onClick={confirmAccountTags}
                  disabled={!accountTags}
                >
                  确认账号标签
                </Button>
              </CardContent>
            </Card>

            <Card className={CARD}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  {/* 「配比：小类 x2 + 脚本核心内容 x2 + 目标用户 x1」收进 title，
                      界面上每组后面的 已选/配额 小字已经把配比表达出来了。 */}
                  <CardTitle
                    className="text-sm font-semibold text-slate-900"
                    title="配比：小类 x2 ＋ 脚本核心内容 x2 ＋ 目标用户 x1"
                  >
                    选题标签
                  </CardTitle>
                  <Button variant="outline" className="h-8 rounded-lg px-3 text-xs" disabled={topicTagsLoading} onClick={loadTopicTags}>
                    {topicTagsLoading ? "生成中…" : tagGroups.length > 0 ? "重新生成" : "生成"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {tagGroups.length === 0 ? (
                  <p className={EMPTY_BOX}>
                    还没有标签
                  </p>
                ) : tagGroups.map(group => (
                  <div key={group.key}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-600">{group.label}</span>
                      {/* 已选 / 配额：数字变蓝 = 凑够了，灰色 = 还差 */}
                      <span className={`text-[11px] ${tagSelected.filter(tag => group.tags.includes(tag)).length >= group.quota ? "text-blue-600" : "text-slate-400"}`}>
                        {tagSelected.filter(tag => group.tags.includes(tag)).length}/{group.quota}
                      </span>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {group.tags.map(tag => {
                        const checked = tagSelected.includes(tag);
                        return (
                          <button
                            key={tag}
                            type="button"
                            aria-pressed={checked}
                            onClick={() => selectImmediately(activeTopicId, current => ({
                              topicTags: {
                                groups: current.topicTags.groups.length > 0 ? current.topicTags.groups : tagGroups,
                                selected: toggle(current.topicTags.selected, tag),
                                missing: current.topicTags.missing,
                              },
                            }))}
                            className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                              checked ? CHIP_ON : CHIP_OFF
                            }`}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {(activeSelection?.topicTags?.missing || []).length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(activeSelection?.topicTags?.missing || []).map(name => (
                      <span key={name} className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">缺 {name}</span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            </div>
          {/* ── 核查 + 导出 ───────────────────────────────────────────────────────── */}
          <Card className={`${CARD} mt-3`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-slate-900">整批核查与导出</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2.5 sm:grid-cols-3">
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <div className="text-xl font-semibold leading-none text-slate-900">{coverCandidates.length}</div>
                  <div className="mt-1 text-[11px] text-slate-500">封面候选{selectedCoverId ? " · 已选 1" : ""}</div>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <div className="text-xl font-semibold leading-none text-slate-900">{copySelected.length}</div>
                  <div className="mt-1 text-[11px] text-slate-500">已选文案</div>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                  <div className="text-xl font-semibold leading-none text-slate-900">{tagSelected.length + confirmedAccountTagList.length}</div>
                  <div className="mt-1 text-[11px] text-slate-500">已选标签</div>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button className="h-9 rounded-lg bg-blue-600 px-3 text-xs font-semibold text-white hover:bg-blue-700" onClick={goToFinalEditor} disabled={loadingSelections || accountTagsLoading || Boolean(exporting)}>
                  进入最终文案编辑页
                </Button>
                <Button variant="outline" className="h-9 rounded-lg px-3 text-xs" disabled={Boolean(exporting)} onClick={() => exportAll("feishu")}>
                  {exporting === "feishu" ? "写入中…" : "写入飞书文档"}
                </Button>
                <Button variant="outline" className="h-9 rounded-lg px-3 text-xs" disabled={Boolean(exporting)} onClick={() => exportAll("bitable")}>
                  {exporting === "bitable" ? "写入中…" : "写入多维表格"}
                </Button>
                {/* 导出读的是「已保存的最终文案」，没保存过会报「暂无可导出」。
                    这是唯一必须说清的前提，压成一行 + title 展开全文。 */}
                <span
                  className="self-center text-[11px] text-slate-400"
                  title="整批导出读取本任务、本批选题已保存的文案，并合入对应的发布选择；无需完成所有发布步骤。"
                >
                  整批导出使用本批已保存文案
                </span>
              </div>

              <Button
                className="h-10 w-full rounded-xl bg-emerald-600 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:bg-emerald-600/40 disabled:opacity-70"
                onClick={confirmComplete}
              >
                确认无误，结束本次任务
              </Button>
              {taskCompleteVisible && (
                <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                  已完成，正在返回工作台…
                </div>
              )}
            </CardContent>
          </Card>
          </>
        )}
      </main>
    </div>
  );
}
