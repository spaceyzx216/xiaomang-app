import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ClipboardList,
  Layers3,
  LoaderCircle,
  LogOut,
  Plus,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { apiUrl } from "./api";
import { useAuth } from "./auth";

type TaskStatus = "pending" | "in_progress" | "completed";

type TodayTask = {
  _id: string;
  /** 客户 id（旧任务可能没有）—— 决定用哪份选题库打标签。 */
  customerId?: string;
  customerName: string;
  customerOccupation?: string;
  contact?: string;
  ownerName?: string;
  platformName?: string;
  collaborationPeriod?: { start?: string; end?: string };
  notes?: string;
  ipPositioning?: string;
  contentDirection?: string;
  benchmarkAccounts?: string;
  contentRequirements?: string[];
  priority?: "low" | "medium" | "high";
  status?: TaskStatus;
};

/** 平台枚举：抖音 / 视频号 / TikTok。 */
type AdhocPlatform = "douyin" | "wechat_channels" | "tiktok";

/**
 * 员工私有的「临时分析」记录 —— 不关联任何客户的对标账号分析。
 *
 * ⚠️ 这个平台清单与后端 `api/_lib/adhocAnalysisStore.js` 的 `ADHOC_PLATFORMS`
 * **一一对应**：那边是后端 .js，它 import 了 mongodb，浏览器里引不进来
 * （HANDOFF §3.6 的架构注意点：把后端模块 import 进前端会让页面整页白屏）。
 * 所以这里镜像一份，**改平台时两处一起改**。
 */
const ADHOC_PLATFORMS: Array<{ key: AdhocPlatform; label: string }> = [
  { key: "douyin", label: "抖音" },
  { key: "wechat_channels", label: "视频号" },
  { key: "tiktok", label: "TikTok" },
];

type AdhocAnalysis = {
  id: string;
  title: string;
  benchmarkAccounts: string;
  platform: AdhocPlatform;
  platformLabel: string;
  /** 与真实任务的 `platformName` 同名字段，合成伪任务时直接搬过去。 */
  platformName: string;
  /** 绑定的客户（2026-09-21 新增）。空串 = 旧记录，还没绑客户。 */
  customerId: string;
  customerName: string;
  createdAt: string;
};

/**
 * 员工可选的客户 —— **只列出已经有正式选题库的客户**。
 *
 * 后端 `/api/topic-libraries` 对员工开放的是收窄过的只读视图（客户名 + 账号数），
 * 不含 IP 档案与访谈原文。绑客户的唯一目的就是拿到那份库当打标签的词典，
 * 所以没有库的客户根本不列出来，免得选完才发现用不了。
 */
type AdhocCustomerOption = {
  customerId: string;
  customerName: string;
  accountCount: number;
};

/** 临时分析列表的时间：**显示到秒**（HANDOFF §6.4㉒，同一天建多条时只显示日期分不清）。 */
const formatAdhocTime = (value?: string) => {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const toDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const previewTasks: TodayTask[] = [
  {
    _id: "preview-fashion-founder",
    customerName: "冯总",
    customerOccupation: "羊毛衫品牌创始人",
    ownerName: "蓬辰",
    platformName: "视频号",
    collaborationPeriod: { start: toDate(), end: toDate(1) },
    ipPositioning: "用经营者视角，讲清羊毛衫的品质与穿搭价值",
    contentDirection: "视频号创作 · 品牌故事与秋冬穿搭",
    contentRequirements: ["围绕品牌创始人的真实经历", "兼顾专业感与生活化表达"],
    benchmarkAccounts: "https://www.douyin.com/user/example-a",
    priority: "medium",
  },
  {
    _id: "preview-labor-lawyer",
    customerName: "夏律",
    customerOccupation: "劳动法律师",
    ownerName: "蓬辰",
    platformName: "视频号",
    collaborationPeriod: { start: toDate(), end: toDate(1) },
    ipPositioning: "面向企业客户，拆解劳动用工中的高频风险",
    contentDirection: "视频号创作 · 企业劳动用工避坑",
    contentRequirements: ["选题需要贴近日常管理场景", "结尾给出可执行的建议"],
    benchmarkAccounts: "https://www.douyin.com/user/example-b",
    priority: "high",
  },
  {
    _id: "preview-health-coach",
    customerName: "林教练",
    customerOccupation: "健康管理师",
    ownerName: "蓬辰",
    platformName: "抖音",
    collaborationPeriod: { start: toDate(), end: toDate(2) },
    ipPositioning: "把复杂的健康知识，变成普通人愿意跟练的习惯",
    contentDirection: "短视频创作 · 轻量化健康习惯",
    contentRequirements: ["内容节奏轻快", "适合通勤时间观看"],
    benchmarkAccounts: "https://www.douyin.com/user/example-c",
    priority: "low",
  },
];

const formatPeriod = (period?: TodayTask["collaborationPeriod"]) => {
  if (!period?.start || !period?.end) return "未设置任务周期";
  return `${String(period.start).slice(5, 10).replace("-", "/")} — ${String(period.end).slice(5, 10).replace("-", "/")}`;
};

const taskStatus = (task: TodayTask): TaskStatus => task.status || "pending";

const isMeaningfulTaskText = (value?: string) => {
  const text = String(value || "").trim();
  return Boolean(text && !["无", "暂无", "未提供", "none", "n/a"].includes(text.toLowerCase()));
};

const benchmarkSummary = (value?: string) => {
  const accounts = String(value || "")
    .split(/[\n,，;；]+/)
    .map(item => item.trim())
    .filter(Boolean);
  return accounts.length > 0 ? `${accounts.length} 个对标账号` : "";
};

export default function TodayTasksPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [tasks, setTasks] = useState<TodayTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingPreview, setUsingPreview] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  // ── 临时分析：不关联客户，员工私有 ──────────────────────────────────────────
  const [adhocItems, setAdhocItems] = useState<AdhocAnalysis[]>([]);
  const [adhocOpen, setAdhocOpen] = useState(false);
  const [adhocTitle, setAdhocTitle] = useState("");
  const [adhocTarget, setAdhocTarget] = useState("");
  const [adhocPlatform, setAdhocPlatform] = useState<AdhocPlatform>("douyin");
  const [adhocCustomerId, setAdhocCustomerId] = useState("");
  const [adhocCustomers, setAdhocCustomers] = useState<AdhocCustomerOption[]>([]);
  const [adhocSubmitting, setAdhocSubmitting] = useState(false);
  const [adhocError, setAdhocError] = useState("");
  const [busyAdhocId, setBusyAdhocId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (params.has("taskToken") || params.has("taskUserId") || params.has("from") || params.has("todayTasks") || params.has("todayTaskCount")) {
      ["taskToken", "taskUserId", "todayTasks", "todayTaskCount", "from"].forEach(key => params.delete(key));
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    }

    const loadTasks = async () => {
      try {
        const response = await fetch(apiUrl("/api/tasks/today"), { credentials: "include" });

        const data = await response.json();
        if (response.status === 401 && typeof window !== "undefined") {
          window.dispatchEvent(new Event("auth:logout"));
        }
        if (!response.ok || !data?.success) throw new Error("任务服务不可用");
        setTasks(Array.isArray(data.data) ? data.data as TodayTask[] : []);
        setUsingPreview(false);
        setErrorMessage("");
      } catch (error) {
        if (import.meta.env.VITE_ENABLE_PREVIEW_TASKS === "true") {
          setTasks(previewTasks);
          setUsingPreview(true);
          setErrorMessage("");
        } else {
          setTasks([]);
          setUsingPreview(false);
          setErrorMessage(error instanceof Error ? error.message : "今日任务同步失败，请稍后重试");
        }
      } finally {
        setLoading(false);
      }
    };

    void loadTasks();
  }, [user?.id]);

  // 临时分析列表**独立加载**：它是附加入口，读失败不该影响今日任务（那是主功能），
  // 所以这里静默降级成「一条都没有」，而不是把整页打成错误态。
  useEffect(() => {
    const loadAdhoc = async () => {
      try {
        const response = await fetch(apiUrl("/api/adhoc-analyses"), { credentials: "include" });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) return;
        setAdhocItems(Array.isArray(data.items) ? data.items as AdhocAnalysis[] : []);
      } catch {
        /* 读不到就当没有 */
      }
    };

    void loadAdhoc();
  }, [user?.id]);

  // 可绑定的客户 = **已经有正式选题库的**客户。同样静默降级：读不到就只显示「暂不绑定」，
  // 不能让附加功能把今日任务打成错误态。
  useEffect(() => {
    const loadCustomers = async () => {
      try {
        const response = await fetch(apiUrl("/api/topic-libraries"), { credentials: "include" });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.success) return;
        const items = Array.isArray(data.items) ? data.items : [];
        setAdhocCustomers(items
          .filter((item: AdhocCustomerOption) => item?.customerId && Number(item.accountCount) > 0)
          .map((item: AdhocCustomerOption) => ({
            customerId: item.customerId,
            customerName: item.customerName,
            accountCount: Number(item.accountCount) || 0,
          })));
      } catch {
        /* 读不到就当没有可选客户 */
      }
    };

    void loadCustomers();
  }, [user?.id]);

  const counts = useMemo(() => ({
    pending: tasks.filter(task => taskStatus(task) === "pending").length,
    inProgress: tasks.filter(task => taskStatus(task) === "in_progress").length,
    completed: tasks.filter(task => taskStatus(task) === "completed").length,
  }), [tasks]);

  /**
   * 进工作区前的清场：写下本次任务，并把上一个任务的选题/抓取残留清掉。
   * ⚠️ `sourcePlatform` / `sourcePlatformUserLocked` 也在这里清 —— 平台要按新任务重新判。
   * ⚠️ `topicsAutoFetchKey` / `...ConsumedKey` 一起清：自动抓取是**一次性**的，
   *    留着上一次的 key 会让下一次进工作区被误判成「已经消费过」。
   */
  const enterWorkspace = (task: TodayTask) => {
    sessionStorage.setItem("contentTasks", JSON.stringify([task]));
    ["selectedTopics", "selectedTopicIds", "tikhubResults", "topicFetchContext", "contentAutoRunKey", "contentActiveGroupIndex", "contentWorkflowFailures", "contentWorkflowFallbackNotes", "contentWorkflowGroups", "workflowRawDone", "contentAutoRunConsumedKey", "contentCustomerId", "sourcePlatform", "sourcePlatformUserLocked", "topicsAutoFetchKey", "topicsAutoFetchConsumedKey"].forEach(key => sessionStorage.removeItem(key));
    navigate("/topics");
  };

  const openTask = (task: TodayTask) => enterWorkspace(task);

  /**
   * 从「临时分析」继续：合成一个**形状与真实任务一致**的伪任务。
   *
   * 为什么这样够用：下游 `/topics` → `/content` → `/final-editor` 本来就不依赖任务
   * （全是 `activeTask?.x || "未提供"`），所以不需要新的分析链路 —— 这正是本方案
   * 只需要「补一扇门」的原因。`_id` 的 `adhoc-` 前缀让下游能把它与客户任务区分开。
   */
  const openAdhoc = (item: AdhocAnalysis, options: { autoFetch?: boolean } = {}) => {
    enterWorkspace({
      _id: `adhoc-${item.id}`,
      // 客户 id 必须带下去：`/topics` 靠它取该客户的选题库，给视频打大类/小类标签。
      customerId: item.customerId || "",
      customerName: item.title,
      // 绑了客户就如实显示，没绑才说「未关联客户」—— 客户决定用哪份选题库当词典。
      customerOccupation: item.customerName ? `临时分析 · 客户：${item.customerName}` : "临时分析 · 未关联客户",
      ownerName: user?.name || "",
      platformName: item.platformName,
      benchmarkAccounts: item.benchmarkAccounts,
      priority: "medium",
      status: "in_progress",
    });
    // ⚠️ 平台是员工在表单里**明确选的**，清场之后再写回去并锁定。
    //    不锁的话 `App.tsx` 的 `inferDefaultPlatform` 只认「视频号 / 微信」，
    //    **TikTok 会被静默推成抖音**（那个正则没有 tiktok 分支）。
    sessionStorage.setItem("sourcePlatform", item.platform);
    sessionStorage.setItem("sourcePlatformUserLocked", "1");
    // 直接把链接写进抓取框的草稿：`/topics` 的 `tikhubInput` 初值就取 sessionStorage，
    // 所以**首帧就已经填好**，不必等那边「从任务预填」的 effect 跑完
    //（自动抓取依赖这一点：它不能抓到上一轮残留的输入）。
    sessionStorage.setItem("tikhubInput", item.benchmarkAccounts);
    // 刚**新建**的那一条：进 `/topics` 后自动开始抓取，省掉「还得再点一次开始获取」。
    // ⚠️ 只有新建这条路带它 —— 从「我的临时分析」点「继续分析」重进时**不带**，
    //    否则每次回看旧记录都会重新花一次 TikHub 调用。
    if (options.autoFetch) {
      sessionStorage.setItem("topicsAutoFetchKey", `adhoc-${item.id}`);
    }
  };

  /**
   * 进「新更新视频筛选与打标签」（模块 3 的 2.4，员工只读视图）。
   *
   * `/topics?view=newVideos&customerId=<id>`：`/topics` 是**员工路由**（`RequireRole employee`），
   * 而 2.4 原本挂在经理端的 `/manager/account-positioning` 下 —— 员工进不去。
   * 所以用同一个组件在员工路由下开一个只读视图：库由项目经理建，员工只拿它当词典。
   *
   * ⚠️ 客户 id 走 URL 而不是 sessionStorage：员工可能在多个标签页看不同客户，
   *    用会话存储会互相串。
   */
  const openNewVideoTagging = (item: AdhocAnalysis) => {
    if (!item.customerId) {
      setAdhocError("这条临时分析还没有绑定客户，无法用客户选题库打标签");
      return;
    }
    navigate(`/topics?view=newVideos&customerId=${encodeURIComponent(item.customerId)}`);
  };

  const createAdhoc = async () => {    const benchmarkAccounts = adhocTarget.trim();
    if (!benchmarkAccounts) {
      setAdhocError("请填写要分析的对标账号链接或账号名称");
      return;
    }
    // HANDOFF §6.4㉑：保存类按钮必须有 in-flight 守卫，否则双击会建出两条一样的记录。
    setAdhocSubmitting(true);
    setAdhocError("");
    try {
      const response = await fetch(apiUrl("/api/adhoc-analyses"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ title: adhocTitle, benchmarkAccounts, platform: adhocPlatform, customerId: adhocCustomerId }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || `创建失败（HTTP ${response.status}）`);
      const item = data.item as AdhocAnalysis;
      setAdhocItems(previous => [item, ...previous]);
      setAdhocTitle("");
      setAdhocTarget("");
      // 新建的这条自动开始抓取（见 `openAdhoc` 的 `autoFetch`）。
      openAdhoc(item, { autoFetch: true });
    } catch (error) {
      setAdhocError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setAdhocSubmitting(false);
    }
  };

  const removeAdhoc = async (id: string) => {
    setBusyAdhocId(id);
    setAdhocError("");
    try {
      const response = await fetch(apiUrl(`/api/adhoc-analyses?id=${encodeURIComponent(id)}`), {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) throw new Error(data?.error || `删除失败（HTTP ${response.status}）`);
      setAdhocItems(previous => previous.filter(item => item.id !== id));
    } catch (error) {
      setAdhocError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusyAdhocId("");
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const statCards = [
    { label: "待处理", count: counts.pending, icon: Clock3, tint: "bg-amber-50 text-amber-600", line: "border-amber-200" },
    { label: "进行中", count: counts.inProgress, icon: Sparkles, tint: "bg-sky-50 text-sky-600", line: "border-sky-200" },
    { label: "已完成", count: counts.completed, icon: CheckCircle2, tint: "bg-emerald-50 text-emerald-600", line: "border-emerald-200" },
  ];

  return (
    <main className="min-h-screen bg-[#f5f7fb] text-slate-900">
      {user?.role === "manager" && <div className="mx-auto max-w-[1500px] px-6 pt-4"><button onClick={() => navigate('/manager')} className="text-sm font-medium text-blue-600">← 返回经理工作台</button></div>}
      <div className="pointer-events-none fixed inset-x-0 top-0 h-[420px] overflow-hidden" aria-hidden="true">
        <div className="absolute -top-48 left-[14%] h-96 w-96 rounded-full bg-blue-200/30 blur-3xl" />
        <div className="absolute -right-20 top-0 h-80 w-80 rounded-full bg-violet-200/25 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-[1480px] px-5 py-6 sm:px-8 lg:px-12 lg:py-9">
        <header className="flex flex-col gap-5 border-b border-slate-200/80 pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.18em] text-blue-600">
              <span className="h-2 w-2 rounded-full bg-blue-600" /> XIAOMANG AI · WORKSPACE
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">今日任务</h1>
            <p className="mt-2 text-sm text-slate-500">选择一个客户任务，开始生成今天值得做的选题。</p>
          </div>
          <div className="flex items-center gap-3 self-start sm:self-auto">
            <div className="hidden rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-[0_8px_28px_rgba(30,41,59,0.06)] backdrop-blur sm:block"><div className="text-xs text-slate-400">当前账号</div><div className="mt-0.5 max-w-[180px] truncate text-sm font-semibold text-slate-700">{user?.name || user?.account || user?.email}</div></div>
            <div className="flex items-center gap-3 rounded-2xl border border-white/80 bg-white/80 px-4 py-3 shadow-[0_8px_28px_rgba(30,41,59,0.06)] backdrop-blur">
            <CalendarDays className="h-5 w-5 text-blue-600" />
            <div>
              <div className="text-xs text-slate-400">TODAY</div>
              <div className="text-sm font-semibold text-slate-700">{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date())}</div>
            </div>
            </div>
            <button type="button" onClick={handleLogout} className="grid h-12 w-12 place-items-center rounded-2xl border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900" aria-label="退出登录" title="退出登录"><LogOut className="h-4 w-4" /></button>
          </div>
        </header>

        <section className="mt-7 grid gap-3 sm:grid-cols-3" aria-label="任务概览">
          {statCards.map(item => (
            <div key={item.label} className={`flex items-center gap-4 rounded-2xl border bg-white/90 px-5 py-4 shadow-[0_10px_30px_rgba(30,41,59,0.05)] ${item.line}`}>
              <div className={`grid h-11 w-11 place-items-center rounded-xl ${item.tint}`}><item.icon className="h-5 w-5" /></div>
              <div><div className="text-2xl font-semibold tracking-tight text-slate-900">{loading ? "—" : item.count}</div><div className="text-sm text-slate-500">{item.label}</div></div>
            </div>
          ))}
        </section>

        <section className="mt-8 overflow-hidden rounded-[28px] border border-slate-200/90 bg-white shadow-[0_20px_60px_rgba(31,41,55,0.08)]">
          <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
            <div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-slate-950 text-white"><ClipboardList className="h-4 w-4" /></div><div><h2 className="font-semibold text-slate-900">待处理任务</h2><p className="text-xs text-slate-500">点击任务卡，进入选题生成</p></div></div>
            <div className="flex flex-wrap items-center gap-2">
              {usingPreview && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-500">当前展示为示例任务</span>}
              <button type="button" onClick={() => { setAdhocOpen(open => !open); setAdhocError(""); }} aria-expanded={adhocOpen} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:text-blue-700"><Plus className="h-3.5 w-3.5" />临时分析对标账号</button>
            </div>
          </div>

          {/* 不关联客户的第二入口。表单**就地展开**（不用弹窗），与页面的卡片语言一致。 */}
          {adhocOpen && (
            <div className="border-b border-slate-100 bg-[#f8fbff] px-5 py-5 sm:px-7">
              <div className="max-w-3xl">
                <p className="text-xs text-slate-500">不关联任何客户，直接分析一个对标账号。创建后会立即进入选题生成，链接已自动填好。</p>
                <div className="mt-4">
                  <div className="text-xs font-semibold text-slate-600">数据平台</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ADHOC_PLATFORMS.map(item => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => { setAdhocPlatform(item.key); setAdhocError(""); }}
                        className={`rounded-full border px-3 py-1 text-xs transition ${adhocPlatform === item.key ? "border-blue-500 bg-blue-50 font-medium text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="mt-4 block text-xs font-semibold text-slate-600">
                  对标账号链接或账号名称
                  <textarea
                    value={adhocTarget}
                    onChange={event => { setAdhocTarget(event.target.value); setAdhocError(""); }}
                    placeholder={adhocPlatform === "wechat_channels" ? "每行一个账号名称，例如：人民日报" : adhocPlatform === "tiktok" ? "每行一个 TikTok 主页，例如：https://www.tiktok.com/@username" : "每行一个抖音主页分享链接"}
                    className="mt-1.5 h-20 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
                <label className="mt-3 block text-xs font-semibold text-slate-600">
                  项目名（选填）
                  <input
                    value={adhocTitle}
                    onChange={event => setAdhocTitle(event.target.value)}
                    maxLength={60}
                    placeholder="留空则记为「临时分析」"
                    className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-normal text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 sm:max-w-xs"
                  />
                </label>
                <label className="mt-3 block text-xs font-semibold text-slate-600">
                  绑定客户（选填，绑了才能用该客户选题库的分类打标签）
                  <select
                    value={adhocCustomerId}
                    onChange={event => { setAdhocCustomerId(event.target.value); setAdhocError(""); }}
                    className="mt-1.5 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-normal text-slate-700 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100 sm:max-w-sm"
                  >
                    <option value="">暂不绑定</option>
                    {adhocCustomers.map(item => (
                      <option key={item.customerId} value={item.customerId}>
                        {item.customerName || item.customerId}（{item.accountCount} 个对标账号）
                      </option>
                    ))}
                  </select>
                  {adhocCustomers.length === 0 && (
                    <span className="mt-1.5 block font-normal leading-5 text-slate-400">
                      目前还没有客户建过选题库。绑客户是为了用它的分类给新视频打标签，没有库时可以先不绑。
                    </span>
                  )}
                </label>
                {adhocError && <p className="mt-3 text-xs text-rose-600">{adhocError}</p>}
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={createAdhoc} disabled={adhocSubmitting} className="inline-flex items-center gap-1.5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50">
                    {adhocSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUpRight className="h-4 w-4" />}
                    {adhocSubmitting ? "创建中…" : "创建并进入分析"}
                  </button>
                  <button type="button" onClick={() => { setAdhocOpen(false); setAdhocError(""); }} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition hover:border-slate-300">取消</button>
                </div>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm text-slate-500"><LoaderCircle className="h-6 w-6 animate-spin text-blue-600" />正在同步今日任务…</div>
          ) : errorMessage ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-5 text-center"><div className="font-medium text-rose-700">今日任务同步失败</div><p className="max-w-sm text-sm text-slate-500">{errorMessage}</p><button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white">重新加载</button></div>
          ) : tasks.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-5 text-center"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-400"><ClipboardList className="h-6 w-6" /></div><div className="font-medium text-slate-700">今天还没有待处理任务</div><p className="max-w-sm text-sm text-slate-500">任务中心同步后，新任务会出现在这里。</p><button type="button" onClick={() => { setAdhocOpen(true); setAdhocError(""); }} className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"><Plus className="h-4 w-4" />分析一个对标账号</button><p className="text-xs text-slate-400">不关联客户 · 分析记录只有你自己能看到</p></div>
          ) : (
            <div className="divide-y divide-slate-100">
              {tasks.map((task, index) => {
                const requirements = (task.contentRequirements || []).filter(Boolean);
                const benchmark = benchmarkSummary(task.benchmarkAccounts);
                const notes = isMeaningfulTaskText(task.notes) ? String(task.notes).trim() : "";
                const priority = task.priority === "high" ? { label: "高", className: "bg-rose-50 text-rose-600" } : task.priority === "low" ? { label: "低", className: "bg-slate-100 text-slate-500" } : { label: "中", className: "bg-amber-50 text-amber-600" };
                return (
                  <button key={task._id || index} type="button" onClick={() => openTask(task)} className="group grid w-full gap-5 px-5 py-6 text-left transition hover:bg-[#f8fbff] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 sm:grid-cols-[minmax(0,1.65fr)_minmax(145px,.7fr)_minmax(160px,.75fr)_auto] sm:items-center sm:px-7">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-[11px] font-semibold tracking-[0.14em] text-slate-400">TASK {String(index + 1).padStart(2, "0")}</span><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${priority.className}`}>{priority.label}优先级</span></div>
                      <h3 className="mt-2 text-lg font-semibold text-slate-900 group-hover:text-blue-700">{task.customerName || "未命名客户"}<span className="ml-2 text-sm font-normal text-slate-400">{task.customerOccupation || "内容创作任务"}</span></h3>
                      <p className="mt-1.5 max-w-2xl truncate text-sm text-slate-500">{task.contentDirection || task.ipPositioning || "补充任务信息后即可生成对应选题"}</p>
                      {requirements.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{requirements.slice(0, 3).map((item, itemIndex) => <span key={itemIndex} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-500">{item}</span>)}</div>}
                      {(benchmark || notes) && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">{benchmark && <span>对标：{benchmark}</span>}{notes && <span className="max-w-xl truncate">备注：{notes}</span>}</div>}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-600"><UserRound className="h-4 w-4 text-slate-400" />{task.ownerName || "待分配"}</div>
                    <div className="flex items-center gap-2 text-sm text-slate-600"><Layers3 className="h-4 w-4 text-slate-400" /><div><div>{task.platformName || "内容平台待定"}</div><div className="mt-0.5 text-xs text-slate-400">{formatPeriod(task.collaborationPeriod)}</div></div></div>
                    <div className="flex items-center justify-between gap-4 sm:justify-end"><span className="text-sm font-medium text-blue-600">开始选题</span><span className="grid h-9 w-9 place-items-center rounded-full border border-slate-200 text-slate-400 transition group-hover:border-blue-600 group-hover:bg-blue-600 group-hover:text-white"><ArrowUpRight className="h-4 w-4" /></span></div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* 我的临时分析：只在有记录时出现，空着不占版面（HANDOFF §6.4⑳ 保持清爽）。 */}
        {adhocItems.length > 0 && (
          <section className="mt-6 overflow-hidden rounded-[28px] border border-slate-200/90 bg-white shadow-[0_20px_60px_rgba(31,41,55,0.08)]">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-5 sm:px-7">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-blue-600"><Sparkles className="h-4 w-4" /></div>
              <div><h2 className="font-semibold text-slate-900">我的临时分析</h2><p className="text-xs text-slate-500">不关联客户的对标账号分析，只有你自己能看到</p></div>
            </div>
            {!adhocOpen && adhocError && <p className="border-b border-rose-100 bg-rose-50 px-5 py-3 text-xs text-rose-600 sm:px-7">{adhocError}</p>}
            <div className="divide-y divide-slate-100">
              {adhocItems.map(item => (
                <div key={item.id} className="group flex items-center gap-4 px-5 py-4 sm:px-7">
                  <button type="button" onClick={() => openAdhoc(item)} className="min-w-0 flex-1 text-left focus-visible:outline-none">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">{item.platformLabel}</span>
                      <h3 className="truncate text-sm font-semibold text-slate-900 group-hover:text-blue-700">{item.title}</h3>
                      {/* 绑了客户才谈得上用它的选题库打标签；没绑就如实说，别让人以为能打。 */}
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${item.customerName ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}>
                        {item.customerName || "未绑定客户"}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">{item.benchmarkAccounts.split("\n")[0]}</p>
                    <p className="mt-1 text-xs text-slate-400">{formatAdhocTime(item.createdAt)}{benchmarkSummary(item.benchmarkAccounts) ? ` · ${benchmarkSummary(item.benchmarkAccounts)}` : ""}</p>
                  </button>
                  {/* 新更新视频筛选与打标签：需要客户选题库当词典，所以只在绑了客户时给入口。 */}
                  {item.customerId ? (
                    <button
                      type="button"
                      onClick={() => openNewVideoTagging(item)}
                      className="hidden shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-blue-300 hover:text-blue-700 sm:inline"
                      title="抓取近期更新、点赞达标的视频并打上库内分类标签"
                    >
                      筛选新视频
                    </button>
                  ) : null}
                  <span className="hidden shrink-0 text-sm font-medium text-blue-600 sm:inline">继续分析</span>
                  <button type="button" onClick={() => removeAdhoc(item.id)} disabled={busyAdhocId === item.id} className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-slate-200 text-slate-400 transition hover:border-rose-300 hover:text-rose-600 disabled:opacity-40" aria-label="删除这条临时分析" title="删除">{busyAdhocId === item.id ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
