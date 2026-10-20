import test from "node:test";
import assert from "node:assert/strict";

import {
  CONTENT_TOPIC_CONCURRENCY,
  CONTENT_TOPIC_TIMEOUT_MS,
  findWorkflowGroupIndex,
  isFatalWorkflowError,
  orderWorkflowGroupsByLinks,
  pickReusableWorkflowGroups,
  sameLink,
} from "../../web/src/app/contentWorkflowRun.ts";
import { mapWithConcurrency } from "../../web/src/app/topicAnalysisPipeline.ts";

/**
 * 二创（内容生成）**并发生成**的契约测试（2026-10-19）。
 *
 * 这些不变量出错时界面看着都正常：
 *   · 结果乱序 → 当前卡片显示的是另一条选题的内容；
 *   · 空结果被当成成功 → 用户以为生成了、点进去是空的；
 *   · 单条失败被算成整批失败 → 30 条里挂 1 条就把已成功的 29 条也丢掉；
 *   · 复用错链接 → 拿着上一条的标题去做发布。
 * 前端没有渲染测试基建，所以把纯逻辑抽到 `contentWorkflowRun.ts` 在这里钉住。
 */

const group = (shareLink, result = { titles: ["标题"], hooks: [], scripts: [] }, id = "") => ({
  id,
  shareLink,
  result,
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("并发完成后按勾选顺序重排，而不是完成顺序（否则卡片内容会串）", async () => {
  const links = ["a", "b", "c", "d"];
  // 模拟真实并发：完成顺序是 d → b → a → c（与勾选顺序完全不同）
  const completed = [];
  await mapWithConcurrency(links, 3, async link => {
    await delay((4 - links.indexOf(link)) * 3);
    completed.push(group(link));
    return link;
  });

  const ordered = orderWorkflowGroupsByLinks(links, completed);
  assert.deepEqual(ordered.map(item => item.shareLink), links, "必须按勾选顺序还原");
  assert.deepEqual(ordered.map(item => item.id), ["link-1", "link-2", "link-3", "link-4"]);
});

test("某条失败时只缺席它自己，后面的条目不能被往前挤（id 必须保持原位）", () => {
  const links = ["a", "b", "c"];
  const groups = [group("a"), group("c")];   // b 失败 / 还没回来

  const ordered = orderWorkflowGroupsByLinks(links, groups);
  assert.deepEqual(ordered.map(item => item.shareLink), ["a", "c"]);
  assert.deepEqual(
    ordered.map(item => item.id),
    ["link-1", "link-3"],
    "c 仍然是第 3 条；挤成 link-2 会让 activeGroupIndex 与 selectedTopics 错位",
  );
});

test("空结果不算成功：三类产物全空的分组必须被排除，重试才会补跑它", () => {
  const links = ["a", "b"];
  const emptyResult = { titles: [], hooks: [], scripts: [] };
  const ordered = orderWorkflowGroupsByLinks(links, [group("a", emptyResult), group("b")]);

  assert.deepEqual(ordered.map(item => item.shareLink), ["b"], "空 payload 不能被当成已生成");
  // 复用同理：空结果不能进 reusable，否则 force:false 会把这条当成「已完成」永远不补跑
  assert.equal(pickReusableWorkflowGroups(links, [group("a", emptyResult)]).length, 0);
});

test("只要有任意一类产物就算生成成功（标题 / 钩子 / 文案）", () => {
  const links = ["t", "h", "s"];
  const ordered = orderWorkflowGroupsByLinks(links, [
    group("t", { titles: ["x"], hooks: [], scripts: [] }),
    group("h", { titles: [], hooks: [{ content: "y" }], scripts: [] }),
    group("s", { titles: [], hooks: [], scripts: [{ content: "z" }] }),
  ]);
  assert.equal(ordered.length, 3, "只有三类全空才算失败");
});

test("复用（重试失败）只取缺的那几条，且同一份结果不会被复制给两条选题", () => {
  const links = ["a", "b", "c"];
  const groups = [group("a"), group("a"), group("c")];   // 同一链接意外出现两份结果

  const reusable = pickReusableWorkflowGroups(links, groups);
  assert.deepEqual(reusable.map(item => item.shareLink), ["a", "c"]);
  assert.equal(reusable[0].id, "link-1");
  assert.equal(reusable[1].id, "link-3");

  // 已有 a、c → force:false 时只应该补跑 b
  const missing = links.filter(link => !reusable.some(item => sameLink(item.shareLink, link)));
  assert.deepEqual(missing, ["b"]);
});

test("sameLink：去空白后全等；空链接不匹配任何东西", () => {
  assert.equal(sameLink(" https://x/1 ", "https://x/1"), true);
  assert.equal(sameLink("https://x/1", "https://x/2"), false);
  assert.equal(sameLink("", ""), false, "空链接不能互相匹配，否则空结果会到处复用");
  assert.equal(sameLink(undefined, "https://x/1"), false);
});

test("致命错误只认「全局都失败」的：401/403 与 DeepSeek 凭证缺失", () => {
  const withStatus = status => Object.assign(new Error("x"), { status });
  const withCode = code => Object.assign(new Error("x"), { code });

  assert.equal(isFatalWorkflowError(withStatus(401)), true, "登录失效：继续跑只会反复触发登出");
  assert.equal(isFatalWorkflowError(withStatus(403)), true);
  assert.equal(isFatalWorkflowError(withCode("DEEPSEEK_TOKEN_MISSING")), true);
  assert.equal(isFatalWorkflowError(withCode("DEEPSEEK_CREDENTIALS_MISSING")), true);

  assert.equal(isFatalWorkflowError(withStatus(429)), false, "限流是单条失败，不能让整批停");
  assert.equal(isFatalWorkflowError(withStatus(500)), false);
  assert.equal(isFatalWorkflowError(withStatus(0)), false);
  assert.equal(isFatalWorkflowError(new DOMException("aborted", "AbortError")), false);
  assert.equal(isFatalWorkflowError(null), false);
});

test("单条选题自己的 * _MISSING 不能算致命：一条坏链接不能停掉整批", () => {
  const withCode = code => Object.assign(new Error("x"), { code });
  // 这些都是「某一条选题」的问题，服务端会把它作为这一条的 SSE Error 返回。
  for (const code of [
    "VIDEO_URL_MISSING",           // 链接被删/私密，解析不到直链
    "WECHAT_MEDIA_URL_MISSING",    // 这条视频号缺媒体直链
    "WECHAT_DECODE_KEY_MISSING",   // 这条视频号缺解密 key
    "ASR_INPUT_MISSING",
    "PCM_INPUT_STREAM_MISSING",
    "SHARE_URL_MISSING",
    "FFMPEG_MISSING",              // 只影响需要现场转写的条目（有脚本的不受影响）
  ]) {
    assert.equal(isFatalWorkflowError(withCode(code)), false, `${code} 必须只失败这一条`);
  }
});

test("并发上限是个有界的小数，且真的按这个上限并发（不是一次全发）", async () => {
  assert.ok(Number.isInteger(CONTENT_TOPIC_CONCURRENCY));
  assert.ok(CONTENT_TOPIC_CONCURRENCY >= 1 && CONTENT_TOPIC_CONCURRENCY <= 8);

  let inFlight = 0;
  let observedPeak = 0;
  await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), CONTENT_TOPIC_CONCURRENCY, async () => {
    inFlight += 1;
    observedPeak = Math.max(observedPeak, inFlight);
    await delay(5);
    inFlight -= 1;
  });
  assert.equal(observedPeak, CONTENT_TOPIC_CONCURRENCY, `峰值并发应为 ${CONTENT_TOPIC_CONCURRENCY}，实际 ${observedPeak}`);
});

test("单条看门狗有合理区间：盖得住正常链路，又要早于 nginx 的 600s", () => {
  assert.ok(Number.isInteger(CONTENT_TOPIC_TIMEOUT_MS));
  assert.ok(CONTENT_TOPIC_TIMEOUT_MS >= 120_000, "小于 2 分钟会误杀正常的长链路");
  assert.ok(CONTENT_TOPIC_TIMEOUT_MS < 600_000, "必须早于 nginx proxy_read_timeout 600s");
});

test("并发重排后能按 link 找回当前卡片（保住用户已勾选的内容）", () => {
  const links = ["a", "b", "c"];
  const before = orderWorkflowGroupsByLinks(links, [group("c")]);
  assert.equal(before[0].id, "link-3");
  const after = orderWorkflowGroupsByLinks(links, [group("c"), group("a")]);

  const previousActiveLink = before[0].shareLink;   // 用户正在看 c（此时在数组下标 0）
  const nextIndex = findWorkflowGroupIndex(after, previousActiveLink);
  assert.equal(nextIndex, 1, "c 重排后到了下标 1，activeGroupIndex 必须跟着走");
  assert.equal(after[nextIndex].shareLink, "c");
  assert.equal(findWorkflowGroupIndex(after, "不存在"), -1);
});

test("并发 + 单条失败混合：失败的缺席，成功的按顺序保留，其余照常完成", async () => {
  const links = ["a", "b", "c", "d", "e"];
  const completed = [];

  const results = await mapWithConcurrency(links, CONTENT_TOPIC_CONCURRENCY, async (link, index) => {
    await delay((5 - index) * 2);
    if (link === "c") throw new Error("这条链接失效");
    completed.push(group(link));
    return link;
  });

  assert.deepEqual(results, ["a", "b", null, "d", "e"], "坏的那条必须是 null，其余不能被牵连");
  const ordered = orderWorkflowGroupsByLinks(links, completed);
  assert.deepEqual(ordered.map(item => item.shareLink), ["a", "b", "d", "e"]);
  assert.deepEqual(ordered.map(item => item.id), ["link-1", "link-2", "link-4", "link-5"]);
});
