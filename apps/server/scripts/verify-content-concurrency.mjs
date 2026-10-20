#!/usr/bin/env node
/**
 * 内容生成页（`/content`）并发生成的**真浏览器**验证 —— `npm run verify:concurrency`
 *
 * 用真实 Chrome + 打桩 SSE 接口验证：
 *   并发 3 条 / 单条失败（含 VIDEO_URL_MISSING）不连坐 / 失败可单独补跑 /
 *   结果按勾选顺序 & id 不位移 / 失败不会自动无限重试 / 兜底结果有显式提示。
 *
 * 为什么单独一个脚本而不是塞进 `npm test`：需要 Chrome、需要先 `npm run build`，
 * 而且会启动本地 HTTP 服务与无头浏览器。在 CI / Docker 里默认跳过。
 *
 * ⚠️ 只打桩 `/api/**`，**不会调用真实模型**、不写数据库。
 *
 * 为什么要真浏览器：项目没有前端交互测试基建，`verify:render` 是 SSR，跑不到 useEffect
 * 和事件处理器；而这次改动全在异步编排与 React state 上。
 *
 * 打桩内容：
 *  - /api/auth/me       → 员工用户
 *  - /api/final-drafts  → 空列表
 *  - /api/agent/workflow/stream-run → 按 share_links 流式返回 SSE；4 条选题里第 3 条失败
 * 并记录服务端观测到的峰值并发、请求次数。
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/server/scripts → 仓库根
const repoRoot = path.resolve(here, "../../..");
const distDir = path.join(repoRoot, "apps/web/dist");
const PORT = 8899;
const CDP_PORT = 9333;

if (!existsSync(path.join(distDir, "index.html"))) {
  console.error("找不到 apps/web/dist/index.html。先运行 `npm run build` 再执行本脚本（这是真浏览器验证，不是单测）。");
  process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

// ── 选题（4 条：第 3 条注定失败）─────────────────────────────────────────────
const topic = n => ({
  id: `topic-${n}`,
  platform: "douyin",
  title: `选题标题 ${n}`,
  authorName: "作者",
  link: `https://v.douyin.com/${n}`,
  stats: { likes: 1000 + n, comments: 10, shares: 5, bookmarks: 8 },
  publishDate: "2026-10-18",
  hotTopics: [],
  content: {
    script: `这是第 ${n} 条选题的口播脚本，用来验证并发与结果顺序。`,
    scriptSource: "transcript",
    categoryName: "大类A",
    subcategoryName: "小类A",
    categoryId: "cat-a",
    confidence: "high",
    basis: "stub",
  },
  rawData: { desc: `选题标题 ${n}` },
});

const topics = [1, 2, 3, 4].map(topic);
const task = {
  _id: "task-1",
  customerName: "测试客户",
  ownerName: "测试员工",
  platformName: "抖音",
  contact: "",
  contentRequirements: ["真实案例"],
  notes: "",
  customerId: "cust-1",
};

const sessionBootstrap = `
(() => {
  try {
    window.__xmBrowserErrors = [];
    window.addEventListener("error", event => window.__xmBrowserErrors.push(String(event && event.message || event)));
    window.addEventListener("unhandledrejection", event => window.__xmBrowserErrors.push("unhandledrejection: " + String((event && event.reason && event.reason.message) || (event && event.reason) || event)));
    const topics = ${JSON.stringify(topics)};
    sessionStorage.setItem("selectedTopics", JSON.stringify(topics));
    sessionStorage.setItem("selectedTopicIds", JSON.stringify(topics.map(t => t.id)));
    sessionStorage.setItem("contentTasks", JSON.stringify([${JSON.stringify(task)}]));
    sessionStorage.setItem("contentCustomerId", "cust-1");
    sessionStorage.setItem("contentActiveGroupIndex", "0");
    sessionStorage.setItem("contentAutoRunKey", "task-1:" + topics.map(t => t.id).join(","));
    // 只在第一次加载时初始化；刷新后要保留「已自动跑过」的状态（这正是要验证的）。
    if (sessionStorage.getItem("contentAutoRunConsumedKey") === null) {
      sessionStorage.setItem("contentAutoRunConsumedKey", "");
    }
    sessionStorage.setItem("xm_auth_user_id", "u-1");
  } catch (error) {
    document.title = "BOOTSTRAP_FAILED:" + String(error && error.message);
  }
})();
`;

// ── 打桩服务 ─────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" };
const requests = [];
let active = 0;
let peak = 0;
const failedOnce = new Set();

const sendSse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/api/auth/me") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user: { id: "u-1", name: "测试员工", role: "employee" } }));
    return;
  }
  if (url.pathname === "/api/final-drafts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
    return;
  }
  if (url.pathname === "/api/agent/workflow/stream-run" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const link = String(body?.parameters?.share_links || "").split("\n").filter(Boolean)[0] || "";
    const maybeTitle = String(body?.parameters?.benchmark_topics?.[0]?.title || "");
    const n = Number((link.match(/\/(\d+)$/) || [])[1] || 0) || 0;
    const record = { link, maybeTitle, ok: false, startedAt: Date.now() };
    requests.push(record);
    active += 1;
    peak = Math.max(peak, active);

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const finish = (ok) => {
      record.ok = ok;
      record.endedAt = Date.now();
      active -= 1;
      res.end();
    };

    // 完成顺序刻意不是勾选顺序：1 → 4 → 3 → 2（不是勾选顺序）。
    // 第 2、3 条第一次失败，点「补跑未生成」后第二次成功。
    const delay = { 1: 260, 2: 640, 3: 420, 4: 520 }[n] || 500;
    setTimeout(() => {
      if ((n === 2 || n === 3) && !failedOnce.has(n)) {
        failedOnce.add(n);
        if (n === 2) {
          // 这是「单条选题」的错误码：必须只失败这一条，不能停掉整批（B1 回归）。
          sendSse(res, "Error", { error_message: "模拟链接失效（VIDEO_URL_MISSING）", code: "VIDEO_URL_MISSING", status: 500 });
        } else {
          sendSse(res, "Error", { error_message: "模拟上游失败", code: "UPSTREAM_ERROR", status: 502 });
        }
        finish(false);
        return;
      }
      if (n === 4) {
        // 模拟一个创作 Agent 用了兜底结果：界面应显式提示，而不是当成完全成功。
        sendSse(res, "Progress", { step: "creative-agents-ready", fallbackCount: 1 });
      }
      const payload = JSON.stringify({
        Code_list: [
          {
            fields: [
              JSON.stringify({
                title: `1. 标题A-${n}\n2. 标题B-${n}`,
                content: `二创文案-${n}`,
              }),
            ],
          },
        ],
      });
      sendSse(res, "Message", { content: payload });
      sendSse(res, "Done", {});
      finish(true);
    }, delay);
    return;
  }

  // 静态资源 / SPA fallback
  const rawPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(distDir, decodeURIComponent(rawPath));
  if (filePath.startsWith(distDir) && existsSync(filePath) && !filePath.endsWith("/")) {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
    return;
  }
  const html = await readFile(path.join(distDir, "index.html"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise(resolve => server.listen(PORT, "127.0.0.1", resolve));
console.log(`stub server: http://127.0.0.1:${PORT}`);

// ── Chrome + 极简 CDP 客户端 ─────────────────────────────────────────────────
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chromePath = chromeCandidates.find(candidate => existsSync(candidate));
if (!chromePath) {
  console.log("跳过：没找到 Chrome/Chromium（可用 CHROME_PATH 指定）。这是可选的真浏览器验证，不属于 npm test。");
  process.exit(0);
}
const profileDir = mkdtempSync(path.join(tmpdir(), "xm-chrome-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    // 本机跑在 DSH 的文件沙箱里：不开 --no-sandbox 时 Chrome 初始化 sandbox 会失败。
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-crash-reporter",
    "--disable-breakpad",
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "about:blank",
  ],
  { stdio: "ignore", detached: false },
);

const cleanup = () => {
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
};
process.on("uncaughtException", error => {
  console.error("uncaughtException:", error);
  cleanup();
  process.exit(1);
});
process.on("unhandledRejection", error => {
  console.error("unhandledRejection:", error);
  cleanup();
  process.exit(1);
});

let wsUrl = "";
for (let i = 0; i < 60 && !wsUrl; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    wsUrl = list.find(item => item.type === "page" && item.webSocketDebuggerUrl)?.webSocketDebuggerUrl || "";
  } catch {
    // chrome 还没起来
  }
  if (!wsUrl) await sleep(200);
}
if (!wsUrl) throw new Error("Chrome CDP 未就绪");
console.log("chrome cdp ready");

const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
console.log("cdp ws connected");
let seq = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = (seq += 1);
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluate failed");
  return result.result?.value;
};
const waitFor = async (predicate, timeoutMs = 15000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await sleep(150);
  }
  return false;
};

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: sessionBootstrap });
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/content` });

  // 第一轮：4 条并发跑；第 2 条报单条错误码（VIDEO_URL_MISSING），第 3 条报上游 502。
  const progressTexts = [];
  const sawFinish = await waitFor(async () => {
    const text = await evaluate("document.body.innerText");
    const progress = text.match(/本轮已完成[^\n]*/)?.[0];
    if (progress && !progressTexts.includes(progress)) progressTexts.push(progress);
    return text.includes("补跑未生成");
  });
  check("第一轮结束（出现「补跑未生成」按钮）", sawFinish, (await evaluate("document.body.innerText")).slice(0, 140).replace(/\s+/g, " "));
  check("生成过程中显示进度（本轮已完成 x/y）", progressTexts.length > 0, progressTexts.join(" / "));

  await waitFor(async () => requests.length >= 4, 8000);
  await sleep(500);

  check("并发确实发生：服务端观测峰值并发 = 3", peak === 3, `peak=${peak}`);
  check("每条选题各发一次请求（4 条 = 4 个请求）", requests.length === 4, `requests=${requests.length}`);
  const failedRequests = requests.filter(item => !item.ok);
  check("只有第 2、3 条失败，其余成功", requests.length === 4 && failedRequests.length === 2, `failed=${failedRequests.length}`);

  const groupsAfterFailure = JSON.parse((await evaluate("sessionStorage.getItem('contentWorkflowGroups')")) || "[]");
  check(
    "B1 回归：VIDEO_URL_MISSING 没有停掉整批 —— 失败条目不占位置，顺序 1,4 / id link-1,link-4",
    groupsAfterFailure.length === 2 &&
      groupsAfterFailure.map(item => item.shareLink).join(",") ===
        "https://v.douyin.com/1,https://v.douyin.com/4" &&
      groupsAfterFailure.map(item => item.id).join(",") === "link-1,link-4",
    JSON.stringify(groupsAfterFailure.map(item => `${item.id}:${item.shareLink}`)),
  );

  const titleOrder = await evaluate(
    "(() => { const t = JSON.parse(sessionStorage.getItem('contentWorkflowGroups')||'[]'); return t.map(g => g.result.titles[0]).join('|'); })()",
  );
  check(
    "结果内容没串（标题内部编号与选题顺序一致）",
    ["A-1", "A-4"].every((label, index) => String(titleOrder).split("|")[index]?.includes(label)),
    String(titleOrder),
  );

  const uiText = await evaluate("document.body.innerText");
  check("界面提供「补跑未生成（2）」按钮", uiText.includes("补跑未生成（2）"), uiText.match(/补跑未生成[^\n]*/)?.[0] || "");
  check("主按钮明确写成「重新生成全部（4 条）」，避免误点全量重跑", uiText.includes("重新生成全部（4 条）"));
  check("未生成清单列出 2 条（含标题与原因）", uiText.includes("还有 2 条未生成") && uiText.includes("「选题标题 2」") && uiText.includes("「选题标题 3」"));
  check("兜底结果被显式提示（不是当成完全成功）", uiText.includes("1 条使用了兜底结果") && uiText.includes("「选题标题 4」"));

  // 关键回归 1：失败不能被自动无限重试
  const requestsBeforeIdle = requests.length;
  await sleep(2500);
  check("失败后不会自动重跑（等待 2.5s 请求数不变）", requests.length === requestsBeforeIdle, `requests=${requests.length}`);

  // 关键回归 2：刷新页面后 —— 已成功的保留、未生成的清单还在、且不会自动再烧一遍
  await send("Page.reload");
  const reloadedReady = await waitFor(async () => {
    const text = await evaluate("document.body.innerText");
    return text.includes("补跑未生成（2）");
  }, 10000);
  await sleep(1500);
  const reloadText = await evaluate("document.body.innerText");
  const groupsAfterReload = JSON.parse((await evaluate("sessionStorage.getItem('contentWorkflowGroups')")) || "[]");
  check("刷新后仍有「补跑未生成（2）」按钮", reloadedReady && reloadText.includes("补跑未生成（2）"));
  check("刷新后已成功的结果保留（2 条）", groupsAfterReload.length === 2, `groups=${groupsAfterReload.length}`);
  check(
    "刷新后未生成清单仍在（标题 + 失败原因都能看到）",
    reloadText.includes("还有 2 条未生成") && reloadText.includes("「选题标题 2」") && reloadText.includes("「选题标题 3」"),
  );
  check("刷新后不会自动重跑（autoRunKey 已消费）", requests.length === 4, `requests=${requests.length}`);
  check(
    "刷新后「兜底结果」提示仍在（不能把模板/原脚本伪装成正常产物）",
    reloadText.includes("1 条使用了兜底结果") && reloadText.includes("「选题标题 4」"),
  );

  // 第二轮：点「补跑未生成」只补跑失败的两条
  const clicked = await evaluate(
    "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('补跑未生成')); if (!b) return false; b.click(); return true; })()",
  );
  check("点击「补跑未生成」", clicked === true);

  const retried = await waitFor(async () => requests.length >= 6, 10000);
  await sleep(1500);
  check("补跑只发 2 个请求（不重跑已成功的 2 条）", retried && requests.length === 6, `requests=${requests.length}`);
  const retriedLinks = requests.slice(4).map(item => item.link).sort().join(",");
  check(
    "补跑请求的就是失败的那两条（第 2、3 条链接）",
    retriedLinks === "https://v.douyin.com/2,https://v.douyin.com/3",
    retriedLinks,
  );

  const groupsAfterRetry = JSON.parse((await evaluate("sessionStorage.getItem('contentWorkflowGroups')")) || "[]");
  check(
    "补跑成功后 4 条齐全且顺序为勾选顺序",
    groupsAfterRetry.length === 4 &&
      groupsAfterRetry.map(item => item.shareLink).join(",") ===
        "https://v.douyin.com/1,https://v.douyin.com/2,https://v.douyin.com/3,https://v.douyin.com/4" &&
      groupsAfterRetry.map(item => item.id).join(",") === "link-1,link-2,link-3,link-4",
    JSON.stringify(groupsAfterRetry.map(item => `${item.id}:${item.shareLink}`)),
  );

  const finalText = await evaluate("document.body.innerText");
  check("补跑后按钮消失、卡片计数 1 / 4", !finalText.includes("补跑未生成（") && finalText.includes("1 / 4"), finalText.match(/当前任务卡片[^\n]*/)?.[0] || "");

  const reloadedConsumed = await evaluate("sessionStorage.getItem('contentAutoRunConsumedKey')");
  check("自动重跑 key 已消费（刷新/返回不会悄悄再烧一遍）", reloadedConsumed === "task-1:topic-1,topic-2,topic-3,topic-4", String(reloadedConsumed));

  // 极端场景：结果缓存被清空（配额/手动清）但 autoRunKey 已消费 → 刷新后
  // 必须仍然给出「补跑未生成」入口，不能出现「清单让你点按钮、按钮却不存在」。
  await evaluate("sessionStorage.removeItem('contentWorkflowGroups'); sessionStorage.removeItem('workflowRawDone'); sessionStorage.setItem('contentWorkflowFailures','[]'); true");
  await send("Page.reload");
  const evidenceReady = await waitFor(async () => {
    const text = await evaluate("document.body.innerText");
    return text.includes("补跑未生成（4）");
  }, 10000);
  await sleep(1200);
  const evidenceText = await evaluate("document.body.innerText");
  check("缓存被清空后刷新：仍有「补跑未生成（4）」按钮", evidenceReady && evidenceText.includes("补跑未生成（4）"));
  check("缓存被清空后刷新：未生成清单与按钮同时出现", evidenceText.includes("还有 4 条未生成"));
  check("缓存被清空后刷新：不会自动重跑", requests.length === 6, `requests=${requests.length}`);

  const errors = await evaluate("window.__xmBrowserErrors ? window.__xmBrowserErrors.join(' | ') : ''");
  check("浏览器无运行期报错", !errors, String(errors || "").slice(0, 200));
} finally {
  try { ws.close(); } catch { /* ignore */ }
  cleanup();
}

const failed = results.filter(item => !item.ok);
console.log(`\n结果: ${results.length - failed.length} passed / ${failed.length} failed`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.label} — ${item.detail}`);
  process.exitCode = 1;
}
