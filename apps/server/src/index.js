import { getDb as getManagerDb, ensureManagerIndexes } from '../api/_lib/manager/db.js';
import managementRouter from './manager/index.js';
import { canUseWorkbench } from '@xiaomang/shared/roles';
import express from "express";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runContentAgentWorkflow } from "../api/_lib/contentAgent/index.js";
import { getContentAgentConfig } from "../api/_lib/contentAgent/config.js";
import { appendQuery, fetchJson, isRetryableNetworkError } from "../api/_lib/contentAgent/http.js";
import { createRequestLogger, safeLink } from "../api/_lib/contentAgent/logger.js";
import { runBenchmarkAnalysisAgent, runBenchmarkProfileAgent, runBenchmarkTopicRefreshAgent, runAccountPlanAgent, runEndingHooksAgent, runGoldThreeSecondsAgent, runRewriteAgent, runTranslationAgent } from "../api/_lib/contentAgent/providers.js";
import {
  buildHeuristicBenchmarkAnalysis,
  normalizeBenchmarkAnalysis,
  normalizeBenchmarkVideos as normalizeAnalysisBenchmarkVideos,
} from "../api/_lib/benchmarkAnalysis.js";
import { deleteBenchmarkReport, getBenchmarkReport, listBenchmarkReports, saveBenchmarkReport } from "../api/_lib/benchmarkReportStore.js";
import {
  buildHeuristicGoldThreeSeconds,
  buildGoldThreeSecondsInput,
  normalizeGoldThreeSeconds,
} from "../api/_lib/goldThreeSeconds.js";
import { deleteGoldThreeSecondReport, getGoldThreeSecondReport, listGoldThreeSecondReports, saveGoldThreeSecondReport } from "../api/_lib/goldThreeSecondStore.js";
import { selectTranscriptTargets, transcribeTargets } from "../api/_lib/goldThreeSecondTranscripts.js";
import { getTranscriptProgress, getTranscripts, saveTranscript, TRANSCRIPT_SCOPE_HEAD, TRANSCRIPT_SCOPE_TAIL } from "../api/_lib/transcriptStore.js";
import { getTranscriptProgress as getTopicRefreshTranscriptProgress, getTranscripts as getTopicRefreshTranscripts, saveTranscript as saveTopicRefreshTranscript, TRANSCRIPT_SCOPE_SCRIPT } from "../api/_lib/transcriptStore.js";
import { buildEndingHooksInput, buildHeuristicEndingHooks, normalizeEndingHooks } from "../api/_lib/endingHooks.js";
import { buildBenchmarkTopicRefreshInput, buildHeuristicBenchmarkTopicRefresh, describeTopicRefreshVideoDrop, normalizeBenchmarkTopicRefresh, normalizeTopicLibrary, normalizeTopicRefreshVideos } from "../api/_lib/benchmarkTopicRefresh.js";
import { deleteEndingHookReport, getEndingHookReport, listEndingHookReports, saveEndingHookReport } from "../api/_lib/endingHookStore.js";
import { PROFILE_SAMPLE_LIMIT, buildHeuristicBenchmarkProfile, normalizeBenchmarkProfile } from "../api/_lib/benchmarkProfile.js";
import { deleteBenchmarkProfileReport, getBenchmarkProfileReport, listBenchmarkProfileReports, saveBenchmarkProfileReport } from "../api/_lib/benchmarkProfileStore.js";
import { buildHeuristicAccountPlan, normalizeAccountPlan } from "../api/_lib/accountPlan.js";
import { deleteAccountPlanReport, getAccountPlanReport, getLatestAccountPlanReportForCustomer, listAccountPlanReports, listAccountPlanReportsForCustomer, saveAccountPlanReport } from "../api/_lib/accountPlanStore.js";
import { getCustomer, listCustomers } from "../api/_lib/ipProfileStore.js";
import { deleteTopicLibrary, getTopicCategoryDictionary, getTopicCategoryDictionaryForEmployee, getTopicLibrary, getTopicLibraryForEmployee, listTopicLibraries, listTopicLibrariesForEmployee, removeTopicLibraryAccount, saveTopicLibrary } from "../api/_lib/topicLibraryStore.js";
import { appendTopicRefreshItems, deleteTopicRefreshSession, dictionaryFingerprint, getTopicRefreshSession, saveTopicRefreshCandidates } from "../api/_lib/topicRefreshSessionStore.js";
import { PUBLISH_PHASES, runPublishPhase } from "../api/_lib/publishAgentRunner.js";
import { runVideoAnalysis } from "../api/_lib/reviewAgentRunner.js";
import { handleWeeklyRequest } from "../api/_lib/weeklyRoutes.js";
import { parseWorkbookPayload } from "../api/_lib/reviewWorkbook.js";
import { getReviewInputOptions, recognizeReviewWorkbook } from "../api/_lib/reviewWorkbookRecognition.js";
import { deleteVideoAnalysisReport, getVideoAnalysisReport, getVideoAnalysisReportForCustomer, listVideoAnalysisReports, listVideoAnalysisReportsForCustomer, saveVideoAnalysisReport } from "../api/_lib/videoAnalysisStore.js";
import { clearPublishSelections, deleteAccountTags, deleteCoverBase, deletePublishSelection, getAccountTags, getCoverBase, listPublishSelections, saveAccountTags, saveCoverBase, savePublishSelection } from "../api/_lib/publishWarehouseStore.js";
import { COVER_TIERS } from "../api/_lib/publishWarehouse.js";
import { fetchFansPortrait } from "../api/_lib/douyinFansPortrait.js";
import { getFansPortrait, saveFansPortrait } from "../api/_lib/fansPortraitStore.js";
import { fetchCommentsBatch, normalizeCommentTargets } from "../api/_lib/videoComments.js";
import { getCommentProgress, getComments, saveComments } from "../api/_lib/commentStore.js";
import { platformRouter } from "../api/_lib/routers/platform.js";
import {
  buildCombinedVideosResponse,
  collectRecentAwemePages,
  MAX_RECENT_DAYS,
  MAX_TOPIC_SLICE_PAGES,
  parseRecentDays,
} from "../api/_lib/topicPagination.js";
import { buildFinalDraftMarkdown } from "../api/_lib/exportFormatters.js";
import {
  buildDraftItem,
  clearDraftItems,
  deleteDraftItem,
  draftScopeKey,
  listDraftItems,
  upsertDraftItems,
} from "../api/_lib/draftItems.js";
import {
  createFeishuBitableForTask,
  writeFinalDraftToFeishu,
  writeFinalDraftToFeishuBitable,
} from "../api/_lib/feishuClient.js";
import { getTodayTasksForUser, isActiveTaskUser, isTaskUserId } from "../api/_lib/taskStore.js";
import { createAdhocAnalysis, deleteAdhocAnalysis, listAdhocAnalyses } from "../api/_lib/adhocAnalysisStore.js";
import { requireAuth } from "../api/_lib/auth.js";
import { authenticateCredentials, registerManager, resolveAuthUser } from "../api/_lib/authStore.js";
import {
  authSessionCookie,
  clearAuthSessionCookie,
  issueAuthToken,
  readAuthToken,
  requestIsSecure,
  verifyAuthToken,
} from "../api/_lib/authToken.js";
import {
  issueTaskSession,
  requestIsSecure as requestIsTaskSessionSecure,
  taskSessionCookie,
} from "../api/_lib/taskSession.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});
dotenv.config({
  path: new URL("./.env", import.meta.url),
  override: true,
});

const app = express();
const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(__dirname, "data");
const finalDraftFile = path.join(dataDir, "final-drafts.json");
const baseUrl = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
const apiToken = process.env.TIKHUB_API_TOKEN || "";
const apiRetryAttempts = Number.parseInt(process.env.AGENT_API_RETRY_ATTEMPTS || "2", 10);
const apiRetryBaseDelayMs = Number.parseInt(process.env.AGENT_API_RETRY_BASE_DELAY_MS || "500", 10);
const startupAgentConfig = getContentAgentConfig();
const TOPIC_PAGE_TIMEOUT_MS = 20_000;
const TOPIC_PAGE_RETRIES = 1;
const TOPIC_INITIAL_PAGE_RETRIES = 1;
const TOPIC_INITIAL_PAGE_RETRY_DELAY_MS = 1200;
const shouldRetryInitialTopicPage = error => (
  isRetryableNetworkError(error) || Number(error?.status) === 400
);
createRequestLogger("server", "startup").info("server.config", {
  port,
  contentProvider: startupAgentConfig.provider,
  agentWorkflowId: startupAgentConfig.mainWorkflowId,
  tikhubBaseUrl: baseUrl,
  transcriptProviders: startupAgentConfig.transcriptProviders.join(","),
  goldTranscriptProviders: startupAgentConfig.goldTranscriptProviders.join(","),
  doubaoResourceId: startupAgentConfig.doubaoResourceId,
  doubaoFileAsrResourceId: startupAgentConfig.doubaoFileAsrResourceId,
  doubaoStreamAsrResourceId: startupAgentConfig.doubaoStreamAsrResourceId,
  doubaoStreamAsrUrl: startupAgentConfig.doubaoStreamAsrUrl,
  tikhubConfigured: Boolean(startupAgentConfig.tikhubApiToken),
  deepseekConfigured: Boolean(startupAgentConfig.deepseekApiKey),
  doubaoAsrConfigured: Boolean(startupAgentConfig.doubaoApiKey || (startupAgentConfig.doubaoAppKey && startupAgentConfig.doubaoAccessKey)),
  doubaoVideoConfigured: Boolean(startupAgentConfig.doubaoVideoEndpoint && startupAgentConfig.doubaoVideoApiKey),
});

// 🔴 带图的接口需要更大的 body 上限。
//
// 封面模板 / 对标封面 / 客户参考照片都是前端读成 base64 dataUrl 再 POST 上来的，
// 一张手机拍的图 base64 之后轻松超过 1MB —— 全局 `1mb` 会直接 413
// （`entity.too.large`），而用户只看到「保存失败」（2026-09-24 实测日志）。
//
// 只给这两个路由放宽，**不要**把全局上限一起抬高（其它路由不需要扛大 body）。
// body-parser 解析成功后会置 `req._body`，所以下面那句全局解析器会自动跳过它们。
// ⚠️ Vercel 侧请求体有 4.5MB 的硬上限，抬这里救不了线上 ——
//    真正让两边都过得去的是**前端上传前先压图**（见 PublishWarehousePage 的 downscaleDataUrl）。
const IMAGE_JSON_LIMIT = "24mb";
const jsonWithImages = express.json({ limit: IMAGE_JSON_LIMIT });
app.use("/api/publish-warehouse", jsonWithImages);
app.use("/api/agent/publish", jsonWithImages);

// 复盘分析的 Excel 上传走 **base64 + JSON**（不是 multipart），理由见 `_lib/reviewWorkbook.js`：
// 本地 Express 与 Vercel 两套入口都要能跑，而 multer 只有前者有。
// 同样只给这一条放宽；解码后的文件大小在 `_lib/reviewWorkbook.js` 里另卡 5MB。
const REVIEW_JSON_LIMIT = "8mb";
app.use("/api/review", express.json({ limit: REVIEW_JSON_LIMIT }));
app.use("/api/weekly-analysis-reports", express.json({ limit: REVIEW_JSON_LIMIT }));

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "xiaomang-proxy",
    time: new Date().toISOString(),
  });
});

app.get('/health/ready', async (_req, res) => {
  try { await (await getManagerDb()).command({ ping: 1 }); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'database-unavailable' }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const login = req.body?.login || req.body?.email || req.body?.account;
    const password = req.body?.password;
    const user = await authenticateCredentials({ login, password });
    if (!user) {
      return res.status(401).json({ success: false, error: "账号或密码错误，或账号已停用" });
    }

    const token = issueAuthToken(user);
    res.setHeader("Set-Cookie", authSessionCookie(token, requestIsSecure(req)));
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "登录服务不可用" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const user = await registerManager(req.body || {});
    const token = issueAuthToken(user);
    res.setHeader("Set-Cookie", authSessionCookie(token, requestIsSecure(req)));
    return res.status(201).json({ success: true, user });
  } catch (error) {
    return res.status(error?.status || 400).json({
      success: false,
      error: error instanceof Error ? error.message : "注册失败",
    });
  }
});

app.get("/api/auth/me", async (req, res) => {
  const token = readAuthToken(req);
  const claims = verifyAuthToken(token);
  if (!claims) return res.status(401).json({ success: false, error: "未登录或登录已过期" });

  try {
    const user = await resolveAuthUser(claims);
    if (!user) return res.status(401).json({ success: false, error: "登录用户不存在或已停用" });
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "认证服务不可用" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", clearAuthSessionCookie(requestIsSecure(req)));
  return res.json({ success: true });
});

// 所有业务 API 统一要求登录。认证接口在上方已经处理，健康检查保持公开。
app.use("/api", async (req, res, next) => {
  const user = await requireAuth(req, res);
  if (user) next();
});

app.post("/api/agent/benchmark-analysis", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const body = req.body || {};
  const contentStyle = String(body.contentStyle || body.content_style || "").trim().toLowerCase() === "drama" ? "drama" : "spoken";
  const platform = String(body.platform || "").trim().toLowerCase() === "tiktok" ? "tiktok" : "douyin";
  const videos = normalizeAnalysisBenchmarkVideos(body.videos, { platform });
  const logger = createRequestLogger("api.agent.benchmark-analysis", req.headers["x-request-id"]);

  if (videos.length === 0) {
    return res.status(400).json({ success: false, error: "没有可分析的视频样本" });
  }

  try {
    const config = getContentAgentConfig();
    let agentOutput;
    let analysisSource = "agent";
    const warnings = [];
    try {
      agentOutput = await runBenchmarkAnalysisAgent({
        contentStyle,
        accountName: body.accountName,
        videos,
      }, config, { logger });
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_AGENT_FAILED",
        error: error instanceof Error ? error.message : "分析 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkAnalysis({ contentStyle, videos });
    }

    const report = normalizeBenchmarkAnalysis({
      contentStyle,
      platform,
      accountUrl: body.accountUrl,
      accountName: body.accountName,
      videos,
      agentOutput,
      analysisSource,
      warnings,
      fetchMode: body.fetchMode,
      // 账号简介 / 粉丝数：1.2「对标账号分析」的商业定位要用。
      accountProfile: body.accountProfile,
    });
    logger.info("route.request.done", {
      interface: "/api/agent/benchmark-analysis",
      analysisSource,
      videoCount: report.analyzedCount,
      categoryCount: report.categories.length,
    });
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Benchmark analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/benchmark-analysis",
      error: message,
    });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

// 近期开更新选题：复用当前账号的分类报告作为标签词典，先分批提取完整脚本，再给每条视频打大类/小类标签。
// 与 Vercel 版 api/agent/benchmark-topic-refresh.ts 保持同构；不创建新的正式选题库集合。
app.post("/api/agent/benchmark-topic-refresh", async (req, res) => {
  // 2026-09-21 用户要求：脚本提取与标签判定不再只给项目经理，员工端「今日选题」也要用。
  // 只要登录即可；转写缓存按当前用户 id 隔离，员工不会读到/污染项目经理的转写。
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }

  const body = req.body || {};
  const phase = String(body.phase || "analyze").trim().toLowerCase();
  const recentDays = Number(body.recentDays || 7);
  const minLikes = Number(body.minLikes ?? 100);
  const videos = normalizeTopicRefreshVideos(body.videos, { minLikes });
  const categories = normalizeTopicLibrary(body.categories || body.topicLibrary);
  const logger = createRequestLogger("api.agent.benchmark-topic-refresh", req.headers["x-request-id"]);

  if (videos.length === 0) {
    return res.status(400).json({
      success: false,
      error: `没有满足筛选条件的可分析视频。${describeTopicRefreshVideoDrop(body.videos, minLikes)}`,
    });
  }
  // ⚠️ 分类词典只有「打标签」那一步用得到，转写不需要 —— 所以这条校验不能卡在转写前面
  //（否则「先提脚本、再读库」的新顺序会被一句与转写无关的 400 挡掉）。
  if (phase !== "transcribe" && categories.length === 0) {
    return res.status(400).json({ success: false, error: "当前账号没有可用的选题库分类" });
  }

  try {
    const config = getContentAgentConfig();
    // ⚠️ 这里**不能**只挑 id/link/title/platform：视频号没有 link，靠 mediaUrl + decodeKey
    //    在本地解密后转写。漏了这两个字段，视频号到 transcribeTargets 里就会报
    //    「缺少媒体地址」，而真正的原因是字段在路由层被丢掉了。
    const targets = videos.map(video => ({
      videoId: video.id,
      link: video.link,
      title: video.title,
      platform: video.platform,
      mediaUrl: video.mediaUrl,
      decodeKey: video.decodeKey,
    }));
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return res.json({ success: true, progress: { total: videoIds.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTopicRefreshTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT });
      if (before.pendingIds.length === 0) return res.json({ success: true, progress: { ...before, finished: true } });

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        clipSeconds: 0,
        scope: TRANSCRIPT_SCOPE_SCRIPT,
        onResult: async result => saveTopicRefreshTranscript({ ownerId: req.authUser.id, ...result }),
      });
      const after = await getTopicRefreshTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT });
      return res.json({
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          scope: TRANSCRIPT_SCOPE_SCRIPT,
          batch: results.map(result => ({
            videoId: result.videoId,
            status: result.status,
            provider: result.provider || "",
            durationMs: result.durationMs,
            ...(result.status === "failed" ? { error: String(result.error || "").slice(0, 200) } : {}),
          })),
        },
      });
    }

    const transcripts = config.goldTranscriptEnabled
      ? await getTopicRefreshTranscripts({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_SCRIPT })
      : new Map();
    let agentOutput;
    let analysisSource = "agent";
    const warnings = [];
    try {
      agentOutput = await runBenchmarkTopicRefreshAgent({ videos, categories, transcripts, recentDays, minLikes }, config, { logger });
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_TOPIC_REFRESH_AGENT_FAILED",
        error: error instanceof Error ? error.message : "近更新选题标签 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkTopicRefresh({ videos, categories, transcripts, recentDays, minLikes });
    }

    const report = normalizeBenchmarkTopicRefresh({ videos, categories, transcripts, agentOutput, recentDays, minLikes });
    report.analysisSource = analysisSource;
    report.warnings = warnings;
    report.input = buildBenchmarkTopicRefreshInput({ videos, categories, transcripts, recentDays, minLikes });
    // 把这一批判完的条目落进「处理进度」（B2）：刷新/离开再回来能续上，不白花转写与模型的钱
    const sessionCustomerId = String(body.customerId || "").trim();
    if (sessionCustomerId) {
      try {
        await appendTopicRefreshItems({
          ownerId: req.authUser.id,
          customerId: sessionCustomerId,
          items: report.items,
          dictionaryHash: dictionaryFingerprint(categories),
        });
      } catch (error) {
        logger.warn("topic.refresh.session_save_failed", {
          customerId: sessionCustomerId,
          error: error instanceof Error ? error.message : "进度落库失败",
        });
      }
    }
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Benchmark topic refresh failed";
    logger.error("route.request.error", { error: message, code: error?.code });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

// 分两个阶段，由前端驱动：
//   phase: "transcribe" → 转写下一批还没有真实口播的样本（每批带时间预算）
//   phase: "analyze"    → 用已有转写跑 DeepSeek 分析，产出报告
// 单条转写实测约 89 秒，20 条装不进一个请求；分批后转写结果按视频落库，
// 同一个视频只付一次成本。与 Vercel 版 api/agent/gold-three-seconds.ts 保持同构。
app.post("/api/agent/gold-three-seconds", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const body = req.body || {};
  const classificationReport = body.classificationReport || body.report;
  const phase = String(body.phase || "analyze").trim().toLowerCase();
  const logger = createRequestLogger("api.agent.gold-three-seconds", req.headers["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return res.status(400).json({ success: false, error: "缺少分类分析报告" });
  }

  try {
    const config = getContentAgentConfig();
    const targets = selectTranscriptTargets(classificationReport, config.goldTranscriptLimit);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return res.json({ success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      // 只认**开头**转写；结尾转写属于 2.3，scope 不同（见 transcriptStore.js）。
      const before = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD });
      if (before.pendingIds.length === 0) {
        return res.json({ success: true, progress: { ...before, finished: true } });
      }

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        // TikHub 解析比裁剪后的转写还慢，用更宽的通道提前跑（与 api/agent 那份保持一致）。
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        clipSeconds: config.goldTranscriptClipSeconds,
        scope: TRANSCRIPT_SCOPE_HEAD,
        // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批就全白做。
        onResult: async result => {
          await saveTranscript({ ownerId: req.authUser.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD });
      logger.info("route.transcribe.done", {
        interface: "/api/agent/gold-three-seconds",
        total: after.total,
        ok: after.ok,
        failed: after.failed,
      });
      return res.json({
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    const input = buildGoldThreeSecondsInput(classificationReport, { limit: config.goldTranscriptLimit });
    if (input.videos.length === 0) {
      return res.status(400).json({ success: false, error: "分类报告中没有可分析的视频样本" });
    }
    const transcripts = config.goldTranscriptEnabled
      ? await getTranscripts({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD })
      : new Map();

    let agentOutput;
    let analysisSource = "agent";
    const warnings = [];
    try {
      agentOutput = await runGoldThreeSecondsAgent({ classificationReport, transcripts }, config, { logger });
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "GOLD_THREE_SECONDS_AGENT_FAILED",
        error: error instanceof Error ? error.message : "黄金三秒 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicGoldThreeSeconds(classificationReport);
    }

    const report = normalizeGoldThreeSeconds({ classificationReport, agentOutput, analysisSource, warnings, transcripts });
    logger.info("route.request.done", {
      interface: "/api/agent/gold-three-seconds",
      analysisSource,
      videoCount: report.analyzedCount,
      topTypeCount: report.topTypes.length,
      transcriptCount: transcripts.size,
    });
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gold three seconds analysis failed";
    logger.error("route.request.error", {
      interface: "/api/agent/gold-three-seconds",
      error: message,
    });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

// GET 列表只返回元数据，正文按 ?id= 单独取；POST 幂等；DELETE 按 ?id= 删除。
app.get("/api/benchmark-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getBenchmarkReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listBenchmarkReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark report request failed" });
  }
});

app.delete("/api/benchmark-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
    const result = await deleteBenchmarkReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark report delete failed" });
  }
});

app.get("/api/gold-three-second-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getGoldThreeSecondReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listGoldThreeSecondReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Gold three seconds report request failed" });
  }
});

app.delete("/api/gold-three-second-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
    const result = await deleteGoldThreeSecondReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Gold three seconds report delete failed" });
  }
});

app.post("/api/gold-three-second-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const item = await saveGoldThreeSecondReport({ ownerId: req.authUser.id, report: req.body?.report });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Gold three seconds report request failed" });
  }
});

// ── 2.3 结尾钩子库分析 ──────────────────────────────────────────────────────
// 与 Vercel 版 api/agent/ending-hooks.ts 保持同构（§6.2⑤：两套后端必须同步改）。
// ⚠️ scope 用 TAIL：结尾钩子看视频收尾，而 2.2 存的是开头片段，两者靠 scope 分开存。
app.post("/api/agent/ending-hooks", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const body = req.body || {};
  const classificationReport = body.classificationReport || body.report;
  const phase = String(body.phase || "analyze").trim().toLowerCase();
  const logger = createRequestLogger("api.agent.ending-hooks", req.headers["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return res.status(400).json({ success: false, error: "缺少分类分析报告" });
  }

  try {
    const config = getContentAgentConfig();
    const targets = selectTranscriptTargets(classificationReport, config.goldTranscriptLimit);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return res.json({ success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL });
      if (before.pendingIds.length === 0) {
        return res.json({ success: true, progress: { ...before, finished: true } });
      }

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        clipSeconds: config.goldTranscriptClipSeconds,
        scope: TRANSCRIPT_SCOPE_TAIL,
        onResult: async result => {
          await saveTranscript({ ownerId: req.authUser.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL });
      logger.info("route.transcribe.done", {
        interface: "/api/agent/ending-hooks",
        scope: TRANSCRIPT_SCOPE_TAIL,
        total: after.total,
        attempted: after.attempted,
        ok: after.ok,
        failed: after.failed,
      });
      return res.json({
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    const input = buildEndingHooksInput(classificationReport, { limit: config.goldTranscriptLimit });
    if (input.videos.length === 0) {
      return res.status(400).json({ success: false, error: "分类报告中没有可分析的视频样本" });
    }
    const transcripts = config.goldTranscriptEnabled
      ? await getTranscripts({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL })
      : new Map();

    let agentOutput;
    let analysisSource = "agent";
    const warnings = [];
    try {
      agentOutput = await runEndingHooksAgent({ classificationReport, transcripts }, config, { logger });
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "ENDING_HOOKS_AGENT_FAILED",
        error: error instanceof Error ? error.message : "结尾钩子 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicEndingHooks(classificationReport);
    }

    const report = normalizeEndingHooks({ classificationReport, agentOutput, analysisSource, warnings, transcripts });
    logger.info("route.request.done", {
      interface: "/api/agent/ending-hooks",
      analysisSource,
      videoCount: report.analyzedCount,
      topTypeCount: report.topTypes.length,
      transcriptCount: transcripts.size,
    });
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ending hooks analysis failed";
    logger.error("route.request.error", { interface: "/api/agent/ending-hooks", code: error?.code, error: message });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

app.get("/api/ending-hook-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getEndingHookReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listEndingHookReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Ending hooks report request failed" });
  }
});

app.delete("/api/ending-hook-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
    const result = await deleteEndingHookReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Ending hooks report delete failed" });
  }
});

app.post("/api/ending-hook-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const item = await saveEndingHookReport({ ownerId: req.authUser.id, report: req.body?.report });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Ending hooks report request failed" });
  }
});

// ── 模块 1　对标账号分析（1.2）──────────────────────────────────────────────
// 与 Vercel 版 api/agent/benchmark-profile.ts 保持同构（§6.2⑤：两套后端必须同步改）。
// ⚠️ 两处与 2.2/2.3 不同：
//   ① 样本只取**点赞最高的前 20 条**（PROFILE_SAMPLE_LIMIT），不是全部 60 条；
//   ② transcribe 阶段要带 scope：先 head（判断三秒）再 tail（判断结尾钩子）。
// 评论不走这里 —— 抓取是数据获取（/api/tikhub/comments），analyze 只从缓存读。
app.post("/api/agent/benchmark-profile", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const body = req.body || {};
  const classificationReport = body.classificationReport || body.report;
  const phase = String(body.phase || "analyze").trim().toLowerCase();
  const scope = String(body.scope || "").trim().toLowerCase() === TRANSCRIPT_SCOPE_TAIL
    ? TRANSCRIPT_SCOPE_TAIL
    : TRANSCRIPT_SCOPE_HEAD;
  // 分类结果是「复用已保存的报告」还是「本次现跑的」——报告里要如实写明。
  const classificationSource = String(body.classificationSource || "").trim().toLowerCase() === "fresh"
    ? "fresh"
    : "reused";
  const logger = createRequestLogger("api.agent.benchmark-profile", req.headers["x-request-id"]);

  if (!classificationReport || typeof classificationReport !== "object") {
    return res.status(400).json({ success: false, error: "缺少分类分析报告" });
  }

  try {
    const config = getContentAgentConfig();
    const targets = selectTranscriptTargets(classificationReport, PROFILE_SAMPLE_LIMIT);
    const videoIds = targets.map(target => target.videoId);

    if (phase === "transcribe") {
      if (!config.goldTranscriptEnabled) {
        return res.json({ success: true, progress: { total: targets.length, ok: 0, failed: 0, attempted: 0, finished: true, disabled: true } });
      }
      const before = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope });
      if (before.pendingIds.length === 0) {
        return res.json({ success: true, progress: { ...before, finished: true } });
      }

      const batchIds = new Set(before.pendingIds.slice(0, config.goldTranscriptBatchSize));
      const batch = targets.filter(target => batchIds.has(target.videoId));
      const results = await transcribeTargets({
        targets: batch,
        config,
        logger,
        budgetMs: config.goldTranscriptBudgetMs,
        concurrency: config.goldTranscriptConcurrency,
        resolveConcurrency: config.goldTranscriptResolveConcurrency,
        clipSeconds: config.goldTranscriptClipSeconds,
        scope,
        onResult: async result => {
          await saveTranscript({ ownerId: req.authUser.id, ...result });
        },
      });

      const after = await getTranscriptProgress({ ownerId: req.authUser.id, videoIds, scope });
      return res.json({
        success: true,
        progress: {
          total: after.total,
          ok: after.ok,
          failed: after.failed,
          attempted: after.attempted,
          finished: after.pendingIds.length === 0,
          remaining: after.pendingIds.length,
          scope,
          batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
        },
      });
    }

    // phase === "analyze"：开头与结尾两份转写都要，scope 必须显式传（§6.6㉚）。
    const [headTranscripts, tailTranscripts, commentsByVideo] = await Promise.all([
      config.goldTranscriptEnabled ? getTranscripts({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_HEAD }) : new Map(),
      config.goldTranscriptEnabled ? getTranscripts({ ownerId: req.authUser.id, videoIds, scope: TRANSCRIPT_SCOPE_TAIL }) : new Map(),
      getComments({ ownerId: req.authUser.id, videoIds }),
    ]);

    // 真实粉丝画像只从缓存读：拉取是独立的数据获取步骤（/api/tikhub/fans-portrait）。
    // sec_user_id 来自分类报告；旧报告没有这个字段，那时 fansPortrait 保持 null。
    // ⚠️ warnings 必须在这条路由的作用域里声明。它原来在下面那句 `let agentOutput` 之前，
    // 2026-09-18 加粉丝画像时被顺手删掉了 —— 结果 Express 版一跑到分析就
    // `warnings is not defined` 直接 500，而 Vercel 版是好的（那边的声明还在）。
    // `node --check` 只查语法、`npm test` 不覆盖 server，所以两边都没拦住。
    const warnings = [];
    let fansPortrait = null;
    const secUserId = String(classificationReport?.account?.secUserId || "").trim();
    if (secUserId) {
      try {
        fansPortrait = await getFansPortrait({ ownerId: req.authUser.id, secUserId });
      } catch (portraitError) {
        // 画像读不到不该让整份报告失败 —— 用户画像退回推断即可。
        warnings.push({
          code: "FANS_PORTRAIT_READ_FAILED",
          error: portraitError instanceof Error ? portraitError.message : "粉丝画像读取失败",
        });
      }
    }

    let agentOutput;
    let analysisSource = "agent";
    try {
      agentOutput = await runBenchmarkProfileAgent(
        { classificationReport, headTranscripts, tailTranscripts, commentsByVideo, fansPortrait },
        config,
        { logger },
      );
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "BENCHMARK_PROFILE_AGENT_FAILED",
        error: error instanceof Error ? error.message : "对标账号分析 Agent 暂时不可用",
        fallbackUsed: true,
      });
      agentOutput = buildHeuristicBenchmarkProfile(classificationReport);
    }

    const report = normalizeBenchmarkProfile({
      classificationReport,
      agentOutput,
      analysisSource,
      warnings,
      headTranscripts,
      tailTranscripts,
      commentsByVideo,
      fansPortrait,
      classificationSource,
    });
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Benchmark profile analysis failed";
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

app.get("/api/benchmark-profile-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getBenchmarkProfileReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listBenchmarkProfileReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark profile report request failed" });
  }
});

app.delete("/api/benchmark-profile-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
    const result = await deleteBenchmarkProfileReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark profile report delete failed" });
  }
});

app.post("/api/benchmark-profile-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const item = await saveBenchmarkProfileReport({ ownerId: req.authUser.id, report: req.body?.report });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark profile report request failed" });
  }
});

// ── 模块 2　账号定位（1.3）第一批 ─────────────────────────────────────────────
// 与 Vercel 版 api/customers.ts / api/agent/account-plan.ts /
// api/account-plan-reports/index.ts 保持同构（§6.2⑤：两套后端必须同步改）。
// ⚠️ 客户名册只做 manager-only，**不按 managerId 过滤** —— `customers` 是公司共用的
// 客户名册，文档上没有 ownerId（与其它集合的隔离规则刻意不同，见 ipProfileStore.js）。
app.get("/api/customers", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getCustomer({ id });
      if (!item) return res.status(404).json({ success: false, error: "客户不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 200);
    return res.json({ success: true, items: await listCustomers({ limit }) });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "客户名册读取失败",
    });
  }
});

app.post("/api/agent/account-plan", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const body = req.body || {};
  const phase = String(body?.phase || "analyze").trim().toLowerCase();
  const customerId = String(body?.customerId || body?.id || "").trim();
  const logger = createRequestLogger("api.agent.account-plan", req.headers["x-request-id"]);

  // 1.3 只有 analyze 一个阶段：两份输入都是现成的，不需要转写与评论抓取。
  if (phase !== "analyze") {
    return res.status(400).json({ success: false, error: "账号定位只有 analyze 阶段（不需要转写与评论抓取）" });
  }
  if (!customerId) {
    return res.status(400).json({ success: false, error: "缺少客户 id" });
  }

  try {
    const customer = await getCustomer({ id: customerId });
    if (!customer) return res.status(404).json({ success: false, error: "客户不存在或已被删除" });

    // 1.2 的报告：优先用请求体传进来的正文（刚跑完可能还没保存），没有才回退到按 id 读库。
    const warnings = [];
    let benchmarkReport = body?.benchmarkProfileReport || body?.benchmarkReport || body?.report || null;
    let benchmarkSource = "本次请求传入的 1.2 对标账号分析报告";
    if (!benchmarkReport || typeof benchmarkReport !== "object") {
      benchmarkReport = null;
      const benchmarkReportId = String(body?.benchmarkProfileReportId || body?.benchmarkReportId || "").trim();
      if (benchmarkReportId) {
        try {
          const stored = await getBenchmarkProfileReport({ ownerId: req.authUser.id, id: benchmarkReportId });
          if (stored?.report) {
            benchmarkReport = stored.report;
            benchmarkSource = "按 id 从 benchmark_profile_reports 读取的 1.2 报告";
          }
        } catch (readError) {
          warnings.push({
            code: "BENCHMARK_PROFILE_READ_FAILED",
            error: readError instanceof Error ? readError.message : "1.2 报告读取失败",
          });
        }
      }
    }
    if (!benchmarkReport) {
      return res.status(400).json({ success: false, error: "缺少 1.2 对标账号分析报告（请先完成模块 1）" });
    }
    if (!String(benchmarkReport?.reportType || "").trim()) {
      benchmarkSource = `${benchmarkSource}（未标注 reportType）`;
    }

    const config = getContentAgentConfig();
    let agentOutput;
    let analysisSource = "agent";
    try {
      agentOutput = await runAccountPlanAgent({ customer, benchmarkReport }, config, { logger });
    } catch (error) {
      analysisSource = "heuristic";
      warnings.push({
        code: error?.code || "ACCOUNT_PLAN_AGENT_FAILED",
        error: error instanceof Error ? error.message : "账号定位 Agent 暂时不可用",
        fallbackUsed: true,
      });
      // 兜底报告：能透传的照透传（1.2 的选题库与高频标签），不能算的全部落「待人工补充」。
      agentOutput = buildHeuristicAccountPlan();
    }

    const report = normalizeAccountPlan({
      customer,
      benchmarkReport,
      agentOutput,
      analysisSource,
      warnings,
      benchmarkSource,
    });
    logger.info("route.request.done", {
      interface: "/api/agent/account-plan",
      analysisSource,
      batch: report.batch,
      producedSectionCount: report.dataCoverage.producedSectionCount,
      benchmarkCategoryCount: report.dataCoverage.benchmarkCategoryCount,
      topicTotal: report.dataCoverage.topicCount.total,
    });
    return res.json({ success: true, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Account plan analysis failed";
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

app.get("/api/account-plan-reports", async (req, res) => {
  // 2026-09-21 用户拍板「3.3 账号标签文档直接开放权限」：
  // **按客户读**（带 `customerId`）对登录用户开放；按 id 取单份 / 列全部仍 manager-only。
  // 边界说明见 `api/account-plan-reports/index.ts` 顶部注释（两套必须同构）。
  const customerId = String(req.query?.customerId || "").trim();
  const isEmployeeRead = Boolean(customerId);
  if (!isEmployeeRead && req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    if (customerId) {
      if (req.query?.latest || req.query?.id === "latest") {
        const item = await getLatestAccountPlanReportForCustomer({ customerId });
        if (!item) return res.status(404).json({ success: false, error: "该客户还没有账号规划报告" });
        return res.json({ success: true, item });
      }
      const limit = Number(req.query?.limit || 12);
      return res.json({ success: true, items: await listAccountPlanReportsForCustomer({ customerId, limit }) });
    }
    const id = String(req.query?.id || "").trim();
    if (id) {
      const item = await getAccountPlanReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listAccountPlanReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "Account plan report request failed" });
  }
});

app.delete("/api/account-plan-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
    const result = await deleteAccountPlanReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Account plan report delete failed" });
  }
});

app.post("/api/account-plan-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const item = await saveAccountPlanReport({ ownerId: req.authUser.id, report: req.body?.report });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Account plan report request failed" });
  }
});

// ── 模块 4　复盘分析（4.1 单条视频数据分析）──────────────────────────────────
// 与 Vercel 版 api/agent/video-analysis.ts / api/video-analysis-reports/index.ts
// 保持同构（§6.2⑤：两套后端必须同步改）。
//
// 分析的是**客户自己发布的视频**（数据由人工从平台后台导出后上传），
// 所以这条链路不抓取、不转写，一次调用出报告；**报告不在这里落库**，
// 用户看过、必要时改过之后再走下面的保存接口。
//
// 权限：4.1 对员工开放（用户 2026-09-30 拍板「经理端新模块 4 + 员工端只读/单条分析」），
// 边界是「按客户」而不是「按所有人」——带 `customerId` 的读登录即可；
// 按 id 取单份 / 列自己的全部仍要 manager，否则员工拿到 id 就能读别人的报告。

// Excel 上传解析：只解析、不落库、不调模型 —— 结果给前端做「列映射确认」。
app.post("/api/review/workbook", async (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  try {
    const parsed = parseWorkbookPayload({
      fileName: req.body?.fileName,
      dataBase64: req.body?.dataBase64,
      platform: req.body?.platform,
      sheetName: req.body?.sheetName,
    });
    return res.json({ success: true, ...parsed });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "Excel 解析失败",
    });
  }
});

app.all('/api/review/workbook-recognition', async (req, res) => {
  try {
    if (req.method === 'GET') return res.json({ success: true, ...getReviewInputOptions(req.query.platform) });
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
    return res.json({ success: true, ...await recognizeReviewWorkbook({ body: req.body }) });
  } catch (error) { return res.status(error.status || 500).json({ success: false, error: error.message || '表格识别失败' }); }
});

app.post("/api/agent/video-analysis", async (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  const customerId = String(req.body?.customerId || "").trim();
  if (!customerId) {
    return res.status(400).json({ success: false, error: "请先选择客户（复盘要用该客户的选题库做结构标签）" });
  }
  try {
    const { report } = await runVideoAnalysis({ customerId, body: req.body });
    return res.json({ success: true, report });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "视频复盘分析失败",
      code: error?.code,
    });
  }
});

app.get("/api/video-analysis-reports", async (req, res) => {
  const customerId = String(req.query?.customerId || "").trim();
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  // 不带 customerId 的两条（按 id 取单份 / 列自己的全部）仍然 manager-only。
  if (!customerId && req.authUser.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const id = String(req.query?.id || "").trim();
    if (customerId) {
      if (id) {
        const item = await getVideoAnalysisReportForCustomer({ customerId, id });
        if (!item) return res.status(404).json({ success: false, error: "报告不存在或不属于该客户" });
        return res.json({ success: true, item });
      }
      const limit = Number(req.query?.limit || 20);
      return res.json({ success: true, items: await listVideoAnalysisReportsForCustomer({ customerId, limit }) });
    }
    if (id) {
      const item = await getVideoAnalysisReport({ ownerId: req.authUser.id, id });
      if (!item) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 12);
    return res.json({ success: true, items: await listVideoAnalysisReports({ ownerId: req.authUser.id, limit }) });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "复盘报告读取失败",
    });
  }
});

app.post("/api/video-analysis-reports", async (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  try {
    const item = await saveVideoAnalysisReport({
      ownerId: req.authUser.id,
      customerId: req.body?.customerId,
      customerName: req.body?.customerName,
      report: req.body?.report,
    });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "复盘报告保存失败",
    });
  }
});

app.delete("/api/video-analysis-reports", async (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  const id = String(req.query?.id || req.body?.id || "").trim();
  if (!id) return res.status(400).json({ success: false, error: "缺少报告 id" });
  try {
    // 按 managerId 收口：员工只能删自己建的（4.1 允许员工创建）。
    const result = await deleteVideoAnalysisReport({ ownerId: req.authUser.id, id });
    if (!result.deleted) return res.status(404).json({ success: false, error: "报告不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "复盘报告删除失败",
    });
  }
});

for (const [route, resource] of [["/api/review/weekly", "analysis"], ["/api/weekly-analysis-reports", "reports"], ["/api/review-memory", "memory"]]) {
  app.all(route, async (req, res) => {
    const result = await handleWeeklyRequest({ method: req.method, user: req.authUser, body: req.body, query: req.query, resource });
    return res.status(result.status).json(result.payload);
  });
}

// ── 模块 3　正式选题库（客户级，每客户一份，可纳入多个对标账号）─────────────
// 与 Vercel 版 api/topic-libraries/index.ts 保持同构（§6.2⑤：两套后端必须同步改）。
// 契约与 benchmark-reports 一致：列表只给元数据，正文按 id（这里是 customerId）单取。
//
// ── 权限（2026-09-21 放宽，用户拍板）────────────────────────────────────────
// **读**：项目经理读自己的库；员工也能读（跑新视频打标签要拿库里的分类当词典）。
//   员工侧走 `*ForEmployee` 两个函数，**刻意收窄**：不回 managerId、不回客户 IP 档案，
//   只给「客户名 + 分类树」，且只列真的有内容的库。
// **写**：建库 / 移除账号 / 删库全部仍为 manager-only。
app.get("/api/topic-libraries", async (req, res) => {
  if (!req.authUser) {
    return res.status(401).json({ success: false, error: "请先登录" });
  }
  try {
    const customerId = String(req.query?.customerId || "").trim();
    // 轻量视图：只要分类词典（员工端打标签用），不拉三份报告快照。
    const categoriesOnly = String(req.query?.view || "").trim() === "categories";
    if (req.authUser.role === "manager") {
      if (customerId) {
        const item = categoriesOnly
          ? await getTopicCategoryDictionary({ ownerId: req.authUser.id, customerId })
          : await getTopicLibrary({ ownerId: req.authUser.id, customerId });
        if (!item) return res.status(404).json({ success: false, error: "这个客户还没有正式选题库" });
        return res.json({ success: true, item });
      }
      const limit = Number(req.query?.limit || 50);
      return res.json({ success: true, items: await listTopicLibraries({ ownerId: req.authUser.id, limit }) });
    }
    // 员工：只读、跨项目经理、收窄字段。
    if (customerId) {
      const item = categoriesOnly
        ? await getTopicCategoryDictionaryForEmployee({ customerId })
        : await getTopicLibraryForEmployee({ customerId });
      if (!item) return res.status(404).json({ success: false, error: "这个客户还没有正式选题库" });
      return res.json({ success: true, item });
    }
    const limit = Number(req.query?.limit || 50);
    return res.json({ success: true, items: await listTopicLibrariesForEmployee({ limit }) });
  } catch (error) {
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "选题库读取失败",
    });
  }
});

app.post("/api/topic-libraries", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const customerId = String(req.body?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "请先选择这份选题库归属的客户" });

    if (String(req.query?.action || "").trim() === "remove-account") {
      const accountKey = String(req.body?.accountKey || "").trim();
      if (!accountKey) return res.status(400).json({ success: false, error: "缺少要移除的对标账号" });
      const removed = await removeTopicLibraryAccount({ ownerId: req.authUser.id, customerId, accountKey });
      if (!removed.removedAccount) return res.status(404).json({ success: false, error: "这个客户还没有正式选题库" });
      return res.json({ success: true, ...removed });
    }

    // 客户名册是公司共用的（不按 managerId 过滤），这里只校验客户真实存在，
    // 避免把随便传的 id 写成一份查不到归属的库。
    const customer = await getCustomer({ id: customerId });
    if (!customer) return res.status(404).json({ success: false, error: "客户不存在或已被删除" });
    if (!req.body?.report) return res.status(400).json({ success: false, error: "缺少要纳入选题库的分类报告" });

    const item = await saveTopicLibrary({
      ownerId: req.authUser.id,
      // 用 **customer.id（规范形态）** 而不是请求里的原始文本 —— 唯一索引比较字符串，
      // 传大写 hex 会建出一份客户端拿小写 id 查不到的库，「一个客户一份库」就破了。
      customer: { id: customer.id, name: customer.name },
      report: req.body.report,
    });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    // 按 store / getCustomer 标好的 `error.status` 取码，不要用正则猜错误消息
    // （`Invalid customer id` 会被 /invalid/ 漏掉 → 本该 400 却返回 500）。
    return res.status(error?.status || 500).json({
      success: false,
      error: error instanceof Error ? error.message : "选题库保存失败",
    });
  }
});

app.delete("/api/topic-libraries", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const customerId = String(req.query?.customerId || req.body?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "缺少客户 id" });
    const result = await deleteTopicLibrary({ ownerId: req.authUser.id, customerId });
    if (!result.deleted) return res.status(404).json({ success: false, error: "这个客户还没有正式选题库" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "选题库删除失败" });
  }
});

// 「新更新视频筛选与打标签」的处理进度（会话）。与 Vercel 版
// api/topic-refresh-sessions/index.ts 保持同构。
//
// 这是**当前用户自己的临时进度**（不是项目经理建的选题库）：不做角色限制，
// 但一律按 `req.authUser.id` 隔离。落库理由见 topicRefreshSessionStore.js ——
// 打标签要几十秒到几分钟，只放前端内存里的话刷新一下就全丢了。
app.get("/api/topic-refresh-sessions", async (req, res) => {
  try {
    const customerId = String(req.query?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "缺少客户 id" });
    const item = await getTopicRefreshSession({ ownerId: req.authUser.id, customerId });
    return res.json({ success: true, item });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "处理进度读取失败" });
  }
});

app.post("/api/topic-refresh-sessions", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await saveTopicRefreshCandidates({
      ownerId: req.authUser.id,
      customerId: body.customerId,
      accountUrl: body.accountUrl,
      recentDays: body.recentDays,
      minLikes: body.minLikes,
      videos: body.videos,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "处理进度保存失败" });
  }
});

app.delete("/api/topic-refresh-sessions", async (req, res) => {
  try {
    const customerId = String(req.query?.customerId || req.body?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "缺少客户 id" });
    const result = await deleteTopicRefreshSession({ ownerId: req.authUser.id, customerId });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "处理进度清除失败" });
  }
});

// ── 发布仓（2026-09-21 第七轮，见 HANDOFF §0.3）────────────────────────────
// 与 `api/agent/publish.ts` / `api/publish-warehouse/index.ts` 同构：
// 逻辑都在 `api/_lib` 共享层，这里只做「鉴权（已有中间件）+ 读 body + 调共享层 + 回 JSON」。
// 登录即可（员工也要用发布仓），数据按 `req.authUser.id` 隔离。
app.post("/api/agent/publish", async (req, res) => {
  const logger = createRequestLogger("api.agent.publish", req.headers["x-request-id"]);
  const body = req.body || {};
  const phase = String(body.phase || "").toLowerCase();
  if (!PUBLISH_PHASES.includes(phase)) {
    return res.status(400).json({
      success: false,
      error: `不支持的 phase：${phase || "(空)"}（可用：${PUBLISH_PHASES.join(" / ")}）`,
      code: "PUBLISH_PHASE_INVALID",
    });
  }
  try {
    const payload = await runPublishPhase({ phase, body, user: req.authUser, logger });
    return res.json({ success: true, ...payload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布仓 Agent 调用失败";
    logger.error("route.request.error", { phase, error: message, code: error?.code });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

app.get("/api/publish-warehouse", async (req, res) => {
  try {
    const resource = String(req.query?.resource || "selections").trim();
    // 封面的三类定义是纯常量（`publishWarehouse.js` 那一份），不依赖客户 —— 前端只管读它渲染。
    if (resource === "cover-tiers") {
      return res.json({ success: true, items: COVER_TIERS });
    }
    const customerId = String(req.query?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "缺少 customerId" });
    if (resource === "account-tags") {
      const item = await getAccountTags({ ownerId: req.authUser.id, customerId });
      return res.json({ success: true, item });
    }
    if (resource === "cover-base") {
      const item = await getCoverBase({ ownerId: req.authUser.id, customerId });
      return res.json({ success: true, item });
    }
    if (resource !== "selections") {
      return res.status(400).json({ success: false, error: `不支持的 resource：${resource}（可用：selections / account-tags / cover-base / cover-tiers）` });
    }
    const items = await listPublishSelections({ ownerId: req.authUser.id, customerId });
    return res.json({ success: true, items });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "发布仓读取失败" });
  }
});

app.post("/api/publish-warehouse", async (req, res) => {
  try {
    const body = req.body || {};
    const resource = String(req.query?.resource || "selections").trim();
    if (resource === "account-tags") {
      const item = await saveAccountTags({
        ownerId: req.authUser.id,
        customerId: body.customerId,
        customerName: body.customerName,
        angleGroups: body.angleGroups,
        confirmed: body.confirmed,
        referenceTags: body.referenceTags,
        summary: body.summary,
      });
      return res.json({ success: true, item });
    }
    if (resource === "cover-base") {
      const item = await saveCoverBase({
        ownerId: req.authUser.id,
        customerId: body.customerId,
        customerName: body.customerName,
        tier: body.tier,
        sourceImage: body.sourceImage,
        analysis: body.analysis,
        titleStyle: body.titleStyle,
        backgroundTemplate: body.backgroundTemplate,
        backgroundPrompt: body.backgroundPrompt,
        portrait: body.portrait,
      });
      return res.json({ success: true, item });
    }
    if (resource !== "selections") {
      return res.status(400).json({ success: false, error: `不支持的 resource：${resource}（可用：selections / account-tags / cover-base）` });
    }
    const item = await savePublishSelection({
      ownerId: req.authUser.id,
      customerId: body.customerId,
      topicId: body.topicId,
      title: body.title,
      cover: body.cover,
      publishCopy: body.publishCopy,
      topicTags: body.topicTags,
    });
    return res.json({ success: true, item });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "发布仓保存失败" });
  }
});

app.delete("/api/publish-warehouse", async (req, res) => {
  try {
    const resource = String(req.query?.resource || "selections").trim();
    const customerId = String(req.query?.customerId || req.body?.customerId || "").trim();
    if (!customerId) return res.status(400).json({ success: false, error: "缺少 customerId" });
    if (resource === "account-tags") {
      return res.json({ success: true, ...(await deleteAccountTags({ ownerId: req.authUser.id, customerId })) });
    }
    if (resource === "cover-base") {
      return res.json({ success: true, ...(await deleteCoverBase({ ownerId: req.authUser.id, customerId })) });
    }
    if (resource !== "selections") {
      return res.status(400).json({ success: false, error: `不支持的 resource：${resource}（可用：selections / account-tags / cover-base）` });
    }
    const topicId = String(req.query?.topicId || "").trim();
    const result = topicId
      ? await deletePublishSelection({ ownerId: req.authUser.id, customerId, topicId })
      : await clearPublishSelections({ ownerId: req.authUser.id, customerId });
    return res.json({ success: true, ...result });
  } catch (error) {
    return res.status(error?.status || 500).json({ success: false, error: error instanceof Error ? error.message : "发布仓删除失败" });
  }
});

app.post("/api/benchmark-reports", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  try {
    const item = await saveBenchmarkReport({
      ownerId: req.authUser.id,
      report: req.body?.report,
      selectedVideoIds: req.body?.selectedVideoIds,
    });
    return res.status(201).json({ success: true, item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Benchmark report save failed" });
  }
});

// 兼容旧桌宠入口：即使调用方仍提供 taskUserId，也必须先通过正式员工登录，
// 且只能为当前登录员工建立会话。新入口直接使用 xm_auth_session，不依赖员工 ID 参数。
app.post("/api/tasks/session", async (req, res) => {
  if (!canUseWorkbench(req.authUser?.role)) {
    return res.status(403).json({ success: false, error: "该任务入口仅供员工使用" });
  }

  const authenticatedUserId = String(req.authUser.employeeId || req.authUser.id || "").trim();
  const requestedTaskUserId = String(req.body?.taskUserId || "").trim();
  const taskUserId = requestedTaskUserId || authenticatedUserId;
  if (requestedTaskUserId && requestedTaskUserId !== authenticatedUserId) {
    return res.status(403).json({ success: false, error: "不能建立其他员工的任务会话" });
  }
  if (!isTaskUserId(taskUserId)) {
    return res.status(400).json({ success: false, error: "Invalid task user identity" });
  }

  try {
    if (!await isActiveTaskUser(taskUserId)) {
      return res.status(401).json({ success: false, error: "Task user is not active" });
    }
    const session = issueTaskSession(taskUserId);
    res.setHeader("Set-Cookie", taskSessionCookie(session, requestIsTaskSessionSecure(req)));
    return res.json({ success: true, data: await getTodayTasksForUser(taskUserId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Session setup failed" });
  }
});

app.get("/api/tasks/today", async (req, res) => {
  if (!canUseWorkbench(req.authUser?.role)) {
    return res.status(403).json({ success: false, error: "今日任务仅供员工使用" });
  }

  try {
    const userId = String(req.authUser.employeeId || req.authUser.id || "").trim();
    return res.json({ success: true, data: await getTodayTasksForUser(userId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Task query failed" });
  }
});

// ── 员工「临时分析」：不关联客户的对标账号分析 ─────────────────────────────────
// 🔴 与其它报告端点不同：这是**员工私有**数据，每个操作都按 userId 收口，
//    经理也可使用，但仍只能读写自己的临时分析。见 `api/_lib/adhocAnalysisStore.js`。
app.get("/api/adhoc-analyses", async (req, res) => {
  if (!canUseWorkbench(req.authUser?.role)) {
    return res.status(403).json({ success: false, error: "临时分析仅供员工使用" });
  }

  try {
    const userId = String(req.authUser.employeeId || req.authUser.id || "").trim();
    return res.json({ success: true, items: await listAdhocAnalyses(userId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Adhoc analysis query failed" });
  }
});

app.post("/api/adhoc-analyses", async (req, res) => {
  if (!canUseWorkbench(req.authUser?.role)) {
    return res.status(403).json({ success: false, error: "临时分析仅供员工使用" });
  }

  try {
    const userId = String(req.authUser.employeeId || req.authUser.id || "").trim();
    const result = await createAdhocAnalysis(userId, req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    return res.status(201).json({ success: true, item: result.item });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Adhoc analysis create failed" });
  }
});

app.delete("/api/adhoc-analyses", async (req, res) => {
  if (!canUseWorkbench(req.authUser?.role)) {
    return res.status(403).json({ success: false, error: "临时分析仅供员工使用" });
  }

  try {
    const id = String(req.query?.id || req.body?.id || "").trim();
    if (!id) return res.status(400).json({ success: false, error: "缺少记录 id" });
    const userId = String(req.authUser.employeeId || req.authUser.id || "").trim();
    const result = await deleteAdhocAnalysis(userId, id);
    if (!result.deleted) return res.status(404).json({ success: false, error: "记录不存在或已被删除" });
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Adhoc analysis delete failed" });
  }
});

const sanitizeUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (error) {
    return rawUrl.split("?")[0];
  }
};

const ensureDataFile = async () => {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(finalDraftFile);
  } catch {
    await fs.writeFile(finalDraftFile, JSON.stringify({ items: [] }, null, 2));
  }
};

const readFinalDrafts = async () => {
  await ensureDataFile();
  const raw = await fs.readFile(finalDraftFile, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
};

const writeFinalDrafts = async (payload) => {
  await ensureDataFile();
  await fs.writeFile(finalDraftFile, JSON.stringify(payload, null, 2));
};

app.post("/api/tikhub/batch", async (req, res) => {
  const logger = createRequestLogger("api.tikhub.batch", req.headers["x-request-id"]);
  const { urls, platform, days = 7, latestOnly = false, maxPages = 20, count = 400, resume = null } = req.body || {};
  const normalizedPlatform = String(platform || "douyin").toLowerCase() === "tiktok" ? "tiktok" : "douyin";
  let recentDays;
  if (!latestOnly) {
    try {
      recentDays = parseRecentDays(days);
    } catch {
      return res.status(400).json({
        error: `days must be an integer between 1 and ${MAX_RECENT_DAYS}`,
        code: "TOPIC_DAYS_INVALID",
      });
    }
  }
  logger.info("route.request.start", {
    interface: "/api/tikhub/batch",
    platform: normalizedPlatform,
    fetchMode: latestOnly ? "latest" : "recent",
    urlCount: Array.isArray(urls) ? urls.length : 0,
  });

  if (!Array.isArray(urls) || urls.length === 0) {
    logger.warn("route.validation.error", { error: "urls must be a non-empty array" });
    return res.status(400).json({ error: "urls must be a non-empty array" });
  }
  if (urls.length !== 1) {
    return res.status(400).json({ error: "每次续拉请求只能包含一个账号", code: "TOPIC_SINGLE_ACCOUNT_REQUIRED" });
  }

  if (!apiToken) {
    logger.error("route.config.error", { error: "Missing TIKHUB_API_TOKEN" });
    return res.status(500).json({
      error: "Missing TIKHUB_API_TOKEN",
    });
  }

  const fetchOpts = {
    timeoutMs: Math.min(startupAgentConfig.requestTimeoutMs, TOPIC_PAGE_TIMEOUT_MS),
    retries: Math.min(Math.max(0, Number.isFinite(apiRetryAttempts) ? apiRetryAttempts : 1), TOPIC_PAGE_RETRIES),
    retryBaseDelayMs: Number.isFinite(apiRetryBaseDelayMs) ? apiRetryBaseDelayMs : 500,
    logger,
    headers: { Authorization: `Bearer ${apiToken}` },
  };

  const results = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      results.push({ url: rawUrl, error: "Empty url" });
      continue;
    }

    const sanitizedUrl = sanitizeUrl(url);
    logger.info("tikhub.item.start", { url: safeLink(sanitizedUrl), platform: normalizedPlatform });
    if (resume?.sourceUrl && sanitizeUrl(String(resume.sourceUrl)) !== sanitizedUrl) {
      results.push({ url, platform: normalizedPlatform, error: "续拉状态与当前账号不匹配", errorStatus: 400 });
      continue;
    }

    let secUserId = String(resume?.secUserId || "").trim();
    let secUserResponse = null;
    let resolvedUsername = String(resume?.username || "").trim();
    let retryResume = {
      cursor: resume?.cursor ?? 0,
      pageOffset: resume?.pageOffset ?? 0,
      ...(secUserId ? { secUserId } : {}),
      ...(resolvedUsername ? { username: resolvedUsername } : {}),
      sourceUrl: sanitizedUrl,
    };
    const slicePageBudget = MAX_TOPIC_SLICE_PAGES;

    try {

      if (normalizedPlatform === "tiktok") {
        // TikTok：主页链接形如 https://www.tiktok.com/@username，提取 username 后查 sec_user_id。
        const username = resolvedUsername || (() => {
          const m = sanitizedUrl.match(/tiktok\.com\/@?([A-Za-z0-9_.]+)/i);
          return m ? m[1] : "";
        })();
        resolvedUsername = username;
        if (!username) {
          results.push({
            url,
            platform: normalizedPlatform,
            error: "无法识别 TikTok 用户名，请输入形如 https://www.tiktok.com/@username 的主页链接",
          });
          continue;
        }
        if (username && !secUserId && resume?.accountResolved !== true) {
          // TikHub TikTok 端点：用 username 换 sec_user_id（失败则 fallback 用 unique_id 直查作品）
          const secEndpoint = `${baseUrl}/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username`;
          try {
            const { data: secUserData } = await fetchJson(
              appendQuery(secEndpoint, { username }),
              { ...fetchOpts, interfaceName: "tikhub:tiktok:get_sec_user_id", retryableExtraStatuses: 400 },
            );
            secUserResponse = secUserData;
            secUserId = secUserData?.data?.sec_user_id || secUserData?.sec_user_id || "";
          } catch (secError) {
            if (Number(secError?.status) === 402) throw secError;
            logger.warn("tikhub.tiktok.sec_user_id.fallback", {
              username,
              error: secError instanceof Error ? secError.message : "sec_user_id resolve failed",
            });
          }
        }
        retryResume = { ...retryResume, secUserId, username, accountResolved: true };
        const videosEndpoint = `${baseUrl}/api/v1/tiktok/app/v3/fetch_user_post_videos`;
        const videosParams = { count: 20 };
        if (secUserId) {
          videosParams.sec_user_id = secUserId;
        } else if (username) {
          videosParams.unique_id = username;
        } else {
          videosParams.url = sanitizedUrl;
        }
        const collection = await collectRecentAwemePages({
          platform: normalizedPlatform,
          days: recentDays,
          latestOnly,
          maxPages,
          slicePages: slicePageBudget,
          startCursor: resume?.cursor ?? 0,
          pageOffset: resume?.pageOffset ?? 0,
          maxVideos: count,
          expectedPageSize: 20,
          initialPageRetries: TOPIC_INITIAL_PAGE_RETRIES,
          initialPageRetryDelayMs: TOPIC_INITIAL_PAGE_RETRY_DELAY_MS,
          shouldRetryInitialPageError: shouldRetryInitialTopicPage,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "tiktok" },
          fetchPage: (cursor, page) => fetchJson(
            appendQuery(videosEndpoint, { ...videosParams, max_cursor: cursor }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:tiktok:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
            },
          ),
        });
        const videosList = collection.videos;
        const nextResume = collection.resume ? { ...collection.resume, secUserId, username, accountResolved: true, sourceUrl: sanitizedUrl } : null;
        const videosResponse = buildCombinedVideosResponse(collection.pages, videosList, { ...collection, resume: nextResume });
        const authorName = videosList?.[0]?.author?.nickname;

        results.push({
          url,
          platform: normalizedPlatform,
          secUserId,
          authorName,
          videosCount: videosList.length,
          secUserResponse,
          videosResponse,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          rawVideosCount: collection.rawVideosCount,
          recentDays: collection.recentDays,
          fetchMode: collection.fetchMode,
          hasMore: collection.hasMore,
          stopReason: collection.stopReason,
          isComplete: collection.isComplete,
          incompleteReason: collection.incompleteReason,
          backgroundError: collection.partialError,
          errorStatus: collection.partialErrorStatus,
          resume: nextResume,
          error: null,
        });
        logger.info("tikhub.item.end", {
          url: safeLink(sanitizedUrl),
          secUserId,
          videosCount: videosList.length,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          stopReason: collection.stopReason,
          hasMore: collection.hasMore,
          resumePageOffset: nextResume?.pageOffset ?? "",
          error: "",
        });
      } else {
        // 抖音：主页链接 → sec_user_id → fetch_user_post_videos
        if (!secUserId) {
          const secEndpoint = `${baseUrl}/api/v1/douyin/web/get_sec_user_id`;
          const { response: secResp, data: secUserData } = await fetchJson(
            appendQuery(secEndpoint, { url: sanitizedUrl }),
            { ...fetchOpts, interfaceName: "tikhub:get_sec_user_id", retryableExtraStatuses: 400 },
          );
          secUserResponse = secUserData;
          secUserId = secUserData?.data || secUserData?.sec_user_id;

          if (!secResp.ok || !secUserId) {
            logger.warn("tikhub.item.failed", {
              step: "get_sec_user_id",
              status: secResp.status,
              error: secUserData?.message || "Failed to resolve sec_user_id",
            });
            results.push({
              url,
              platform: normalizedPlatform,
              secUserResponse,
              error: secUserData?.message || "Failed to resolve sec_user_id",
            });
            continue;
          }
        }
        retryResume = { ...retryResume, secUserId };

        const appVideosEndpoint = `${baseUrl}/api/v1/douyin/app/v3/fetch_user_post_videos`;
        const webVideosEndpoint = `${baseUrl}/api/v1/douyin/web/fetch_user_post_videos`;
        const initialLogicalPage = (Number(resume?.pageOffset) || 0) + 1;
        let useWebVideosEndpoint = false;
        const fetchDouyinVideosPage = async (cursor, page) => {
          const appRequest = () => fetchJson(
            appendQuery(appVideosEndpoint, {
              sec_user_id: secUserId,
              count: 20,
              max_cursor: cursor,
              sort_type: 0,
            }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:douyin:app:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
            },
          );
          const webRequest = () => fetchJson(
            appendQuery(webVideosEndpoint, {
              sec_user_id: secUserId,
              count: 20,
              max_cursor: cursor,
              filter_type: 0,
            }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:douyin:web:fetch_user_post_videos",
              logFields: { page },
            },
          );

          if (useWebVideosEndpoint) return webRequest();
          try {
            return await appRequest();
          } catch (error) {
            if (page !== initialLogicalPage || !shouldRetryInitialTopicPage(error)) throw error;
            useWebVideosEndpoint = true;
            logger.warn("tikhub.douyin.app_to_web_fallback", {
              page,
              error: error instanceof Error ? error.message : "App V3 request failed",
              code: error?.code,
              status: error?.status,
            });
            return webRequest();
          }
        };
        const collection = await collectRecentAwemePages({
          platform: normalizedPlatform,
          days: recentDays,
          latestOnly,
          maxPages,
          slicePages: slicePageBudget,
          startCursor: resume?.cursor ?? 0,
          pageOffset: resume?.pageOffset ?? 0,
          maxVideos: count,
          expectedPageSize: 20,
          initialPageRetries: TOPIC_INITIAL_PAGE_RETRIES,
          initialPageRetryDelayMs: TOPIC_INITIAL_PAGE_RETRY_DELAY_MS,
          shouldRetryInitialPageError: shouldRetryInitialTopicPage,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "douyin" },
          fetchPage: fetchDouyinVideosPage,
        });
        const videosList = collection.videos;
        const nextResume = collection.resume ? { ...collection.resume, secUserId, sourceUrl: sanitizedUrl } : null;
        const videosResponse = buildCombinedVideosResponse(collection.pages, videosList, { ...collection, resume: nextResume });
        const authorName = videosList?.[0]?.author?.nickname;

        results.push({
          url,
          platform: normalizedPlatform,
          secUserId,
          authorName,
          videosCount: videosList.length,
          secUserResponse,
          videosResponse,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          rawVideosCount: collection.rawVideosCount,
          recentDays: collection.recentDays,
          fetchMode: collection.fetchMode,
          hasMore: collection.hasMore,
          stopReason: collection.stopReason,
          isComplete: collection.isComplete,
          incompleteReason: collection.incompleteReason,
          backgroundError: collection.partialError,
          errorStatus: collection.partialErrorStatus,
          resume: nextResume,
          error: null,
        });
        logger.info("tikhub.item.end", {
          url: safeLink(sanitizedUrl),
          secUserId,
          videosCount: videosList.length,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          stopReason: collection.stopReason,
          hasMore: collection.hasMore,
          resumePageOffset: nextResume?.pageOffset ?? "",
          error: "",
        });
      }
    } catch (error) {
      logger.error("tikhub.item.error", {
        url: safeLink(sanitizedUrl),
        error: error instanceof Error ? error.message : "Request failed",
      });
      results.push({
        url,
        platform: normalizedPlatform,
        errorStatus: Number(error?.status) || null,
        resume: retryResume,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  logger.info("route.request.done", {
    interface: "/api/tikhub/batch",
    resultCount: results.length,
    errorCount: results.filter(item => item?.error).length,
  });
  return res.json({ results });
});

// 对标视频「高赞评论」抓取。与 Vercel 版 api/tikhub/comments.ts 保持同构：
// 前端驱动分批，只抓还没缓存的视频（付费的 TikHub 接口，缓存即省钱），
// 每完成一条立刻落库，函数中断也不会丢掉已经花掉的钱。
app.post("/api/tikhub/comments", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }

  const logger = createRequestLogger("api.tikhub.comments", req.headers["x-request-id"]);
  const targets = normalizeCommentTargets(req.body || {});
  if (targets.length === 0) {
    logger.warn("route.validation.error", { error: "videos must be a non-empty array" });
    return res.status(400).json({ success: false, error: "videos 必须是非空数组" });
  }
  if (!apiToken) {
    logger.error("route.config.error", { error: "Missing TIKHUB_API_TOKEN" });
    return res.status(500).json({ success: false, error: "Missing TIKHUB_API_TOKEN" });
  }

  try {
    const config = getContentAgentConfig();
    const videoIds = targets.map(target => target.videoId);
    const before = await getCommentProgress({ ownerId: req.authUser.id, videoIds });
    logger.info("route.request.start", {
      interface: "/api/tikhub/comments",
      videoCount: videoIds.length,
      pendingCount: before.pendingIds.length,
    });

    if (before.pendingIds.length === 0) {
      return res.json({
        success: true,
        progress: {
          total: before.total,
          ok: before.ok,
          failed: before.failed,
          attempted: before.attempted,
          finished: true,
          remaining: 0,
          batch: [],
        },
      });
    }

    // 只取下一批还没缓存的。batch 用 targets 过滤而不是直接拿 pendingIds：
    // 目标里带着 platform，且顺序以调用方给的为准（视频号顺序稳定，进度才好复核）。
    const batchIds = new Set(before.pendingIds.slice(0, config.benchmarkCommentBatchSize));
    const batch = targets.filter(target => batchIds.has(target.videoId));
    const results = await fetchCommentsBatch({
      targets: batch,
      config,
      logger,
      budgetMs: config.benchmarkCommentBudgetMs,
      concurrency: config.benchmarkCommentConcurrency,
      // 每完成一条立刻落库：整批跑完才写的话，函数被平台杀掉这一批的钱就白花了。
      onResult: async result => {
        await saveComments({ ownerId: req.authUser.id, ...result });
      },
    });

    const after = await getCommentProgress({ ownerId: req.authUser.id, videoIds });
    logger.info("route.request.done", {
      interface: "/api/tikhub/comments",
      total: after.total,
      ok: after.ok,
      failed: after.failed,
      attempted: after.attempted,
      remaining: after.pendingIds.length,
    });
    return res.json({
      success: true,
      progress: {
        total: after.total,
        ok: after.ok,
        failed: after.failed,
        attempted: after.attempted,
        // 全部尝试过（含失败）才算 finished —— 与前端的分批循环约定一致。
        finished: after.pendingIds.length === 0,
        remaining: after.pendingIds.length,
        batch: results.map(result => ({ videoId: result.videoId, status: result.status, provider: result.provider || "", durationMs: result.durationMs })),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "评论抓取失败";
    logger.error("route.request.error", {
      interface: "/api/tikhub/comments",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

// 抖音「热榜」粉丝画像 —— 模块 1 用户画像的真实数据源。
// 与 Vercel 版 api/tikhub/fans-portrait.ts 保持同构（§6.2⑤：两套后端必须同步改）。
// ⚠️ 付费调用，且**一次只能拿一个维度**（传多个 option 会 HTTP 422），
// 所以一次请求并发打 8 个上游 GET；账号级缓存 7 天，同一个账号只付一次钱。
app.post("/api/tikhub/fans-portrait", async (req, res) => {
  if (req.authUser?.role !== "manager") {
    return res.status(403).json({ success: false, error: "该功能仅供项目经理使用" });
  }
  const logger = createRequestLogger("api.tikhub.fans-portrait", req.headers["x-request-id"]);
  const secUserId = String(req.body?.secUserId || "").trim();

  // 旧分类报告没有 sec_user_id：如实说明原因，让前端提示重新跑一次分类分析。
  if (!secUserId) {
    return res.json({
      success: true,
      portrait: { ok: false, reason: "missing_sec_user_id", secUserId: "", dimensions: [], failed: [], fetchedAt: "" },
    });
  }

  try {
    const cached = await getFansPortrait({ ownerId: req.authUser.id, secUserId });
    if (cached) {
      return res.json({ success: true, portrait: cached });
    }

    const agentConfig = getContentAgentConfig();
    const portrait = await fetchFansPortrait({ secUserId, config: agentConfig, logger });
    // 失败不写缓存：重抓只要 8 次廉价 GET，缓存一次抖动会让用户七天看不到画像。
    const saved = portrait.ok ? await saveFansPortrait({ ownerId: req.authUser.id, portrait }) : null;
    return res.json({ success: true, portrait: saved || { ...portrait, fromCache: false } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "粉丝画像获取失败";
    logger.error("route.request.error", { interface: "/api/tikhub/fans-portrait", error: message });
    return res.status(error?.status || 500).json({ success: false, error: message, code: error?.code });
  }
});

// platform 路由（accounts/search、topics/batch、topics/share-link）合并为单个 handler。
// 共享 handler 同时服务线上 Vercel（api/platform.ts）与本地 Express，按 req.url 末尾分发。
app.post("/api/platform/accounts/search", (req, res) => platformRouter(req, res));
app.post("/api/platform/topics/batch", (req, res) => platformRouter(req, res));
app.post("/api/platform/topics/share-link", (req, res) => platformRouter(req, res));

app.post("/api/agent/workflow/stream-run", async (req, res) => {
  const logger = createRequestLogger("api.agent.workflow.stream-run", req.headers["x-request-id"]);
  const agentConfig = getContentAgentConfig();
  const body = {
    ...req.body,
    workflow_id: req.body?.workflow_id || agentConfig.mainWorkflowId,
  };

  if (body.bot_id && body.app_id) {
    logger.warn("route.validation.error", { error: "bot_id and app_id cannot be specified together" });
    return res.status(400).json({
      error: "bot_id and app_id cannot be specified together",
    });
  }

  logger.info("route.request.start", {
    interface: "/api/agent/workflow/stream-run",
    workflowId: body.workflow_id,
    mode: "agent",
  });

  return runContentAgentWorkflow(req, res, { body, config: agentConfig, logger });
});

app.post("/api/final-drafts", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  try {
    const item = buildDraftItem(req.body || {}, user.id);
    const db = await readFinalDrafts();
    const items = upsertDraftItems(Array.isArray(db.items) ? db.items : [], item);
    await writeFinalDrafts({ items });
    const scopeKey = draftScopeKey(item);
    const stored = scopeKey ? items.find(entry => draftScopeKey(entry) === scopeKey) : items[0];
    return res.json({ success: true, item: stored || item });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Save failed",
    });
  }
});

app.get("/api/final-drafts", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  try {
    const db = await readFinalDrafts();
    const items = listDraftItems(db.items, user.id, {
      customerId: req.query?.customerId,
      taskId: req.query?.taskId,
    });
    return res.json({ success: true, items });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Read failed",
    });
  }
});

app.delete("/api/final-drafts", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  try {
    const db = await readFinalDrafts();
    const { items, removed } = clearDraftItems(db.items, user.id);
    await writeFinalDrafts({ items });
    return res.json({ success: true, removedAll: true, removed });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Delete all failed",
    });
  }
});

app.delete("/api/final-drafts/:id", async (req, res) => {
  const user = await requireAuth(req, res);
  if (!user) return;
  const id = String(req.params?.id || "").trim();
  if (!id) {
    return res.status(400).json({ success: false, error: "id is required" });
  }
  try {
    const db = await readFinalDrafts();
    const { items, removed } = deleteDraftItem(db.items, user.id, id);
    await writeFinalDrafts({ items });
    return res.json({ success: true, removed });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Delete failed",
    });
  }
});

app.post("/api/export/feishu", async (req, res) => {
  const logger = createRequestLogger("api.export.feishu", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/feishu",
    mode: "docx.write",
  });

  try {
    const result = await writeFinalDraftToFeishu(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/feishu",
      documentId: result.documentId,
      blocksCreated: result.blocksCreated,
    });
    return res.json({
      success: true,
      message: "已写入飞书文档",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu export failed";
    logger.error("route.request.error", {
      interface: "/api/export/feishu",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
      markdown: buildFinalDraftMarkdown(req.body || {}),
    });
  }
});

app.post("/api/export/bitable", async (req, res) => {
  const logger = createRequestLogger("api.export.bitable", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable",
    mode: "bitable.write",
  });

  try {
    const result = await writeFinalDraftToFeishuBitable(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable",
      appToken: result.appToken,
      tableId: result.tableId,
      recordCount: result.recordCount,
      recordsCreated: result.recordsCreated,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return res.json({
      success: true,
      message: "已写入飞书多维表格",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable export failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
    });
  }
});

app.post("/api/export/bitable/create", async (req, res) => {
  const logger = createRequestLogger("api.export.bitable.create", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable/create",
    mode: "bitable.create",
  });

  try {
    const result = await createFeishuBitableForTask(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable/create",
      appToken: result.appToken,
      tableId: result.tableId,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return res.json({
      success: true,
      message: "已创建飞书多维表格",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable create failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable/create",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
    });
  }
});

app.post("/api/agent/translation", async (req, res) => {
  const logger = createRequestLogger("api.agent.translation", req.headers["x-request-id"]);
  const payload = req.body?.payload || req.body || {};
  logger.info("route.request.start", {
    interface: "/api/agent/translation",
    titleCount: Array.isArray(payload?.titles) ? payload.titles.length : 0,
    hookCount: Array.isArray(payload?.hooks) ? payload.hooks.length : 0,
    scriptCount: Array.isArray(payload?.scripts) ? payload.scripts.length : 0,
  });

  try {
    const result = await runTranslationAgent(payload, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/agent/translation",
      resultCount: Array.isArray(result?.translations) ? result.translations.length : 0,
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed";
    logger.error("route.request.error", {
      interface: "/api/agent/translation",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({ error: message, code: error?.code });
  }
});

app.post("/api/agent/rewrite", async (req, res) => {
  const logger = createRequestLogger("api.agent.rewrite", req.headers["x-request-id"]);
  const scripts = Array.isArray(req.body?.scripts) ? req.body.scripts : [];
  const targetPlatform = String(req.body?.targetPlatform || req.body?.target_platform || "douyin");
  logger.info("route.request.start", {
    interface: "/api/agent/rewrite",
    targetPlatform,
    scriptCount: scripts.length,
  });

  try {
    const result = await runRewriteAgent({ targetPlatform, scripts }, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/agent/rewrite",
      resultCount: Array.isArray(result?.results) ? result.results.length : 0,
    });
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rewrite failed";
    logger.error("route.request.error", {
      interface: "/api/agent/rewrite",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({ error: message, code: error?.code });
  }
});

/**
 * 兜底错误处理 —— 把任何未捕获的异常、以及 body 解析错误，统一变成 **JSON**。
 *
 * 🔴 为什么必须有它：没有这个中间件时，Express 会返回**默认的 HTML 错误页**，
 * 前端 `parseApiJson` 解析不出 `error` 字段，只能显示一句
 * 「请求失败（HTTP 500）」—— **真正的原因全被吞掉**。
 * 2026-09-18 排查「1.3 保存报告返回 500」时就卡在这上面：后端明明抛了异常，
 * 界面上却只有状态码，服务端日志里也不显眼。
 *
 * ⚠️ 必须放在所有路由**之后**（Express 靠参数个数 4 个来识别错误中间件）。
 * Vercel 侧各端点自己有 try/catch，不经过这里。
 */
app.use("/api/management", managementRouter);

const webDist = path.resolve(__dirname, '../../web/dist');
app.use(express.static(webDist));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || !req.accepts('html')) return next();
  res.sendFile(path.join(webDist, 'index.html'), error => { if (error) next(error); });
});

app.use((err, req, res, next) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  const message = err instanceof Error ? err.message : String(err || "服务器内部错误");
  // body 解析失败（如体积超限）也要说清是哪一类，否则只看到一个 500。
  const code = err?.type || err?.code || undefined;
  // 体积超限要给**能照做**的提示：body-parser 的原文是「request entity too large」，
  // 用户看不出该动哪里（2026-09-24 实测就是这条）。
  const userMessage = err?.type === "entity.too.large"
    ? "上传内容太大：封面图片请压缩到 4MB 以内再试（建议长边不超过 1440px）。"
    : message;
  try {
    createRequestLogger("server.unhandled", req.headers?.["x-request-id"])
      .error("route.unhandled_error", { method: req.method, url: req.originalUrl, status, code, error: message });
  } catch { /* 记日志失败不能影响响应 */ }
  if (res.headersSent) return next(err);
  return res.status(status).json({ success: false, error: userMessage, code });
});

await ensureManagerIndexes();
app.listen(port, () => {
  console.log(`[tikhub-proxy] listening on http://localhost:${port}`);
});
