/**
 * 二创（内容生成）批量运行的**纯部件**：并发上限、致命失败判定、结果合并/排序。
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────────
 * `ContentPage.tsx` 有 100KB+ 且依赖 React / 浏览器 API，`node --test` 加载不了；
 * 而下面这几个判断都是**静默出错**型不变量 —— 几十条选题并发跑的时候，
 * 结果顺序错位、复用错链接、某条失败被算成成功，界面看起来全都正常，
 * 只有用户拿去发布时才会发现。抽成无副作用模块后由
 * `apps/server/tests/content-workflow-run.test.mjs` 直接钉住。
 *
 * ── 为什么需要并发 ────────────────────────────────────────────────────────
 * 二创是「每条选题 → 4 个 DeepSeek Agent 并行」，单条实测大约 20~60 秒。
 * 原来的前端循环是**严格串行**的（一条 Done 了才发下一条），于是勾选 30 条
 * 就要等 30 个单条时长（10~30 分钟）。改成有界并发后总时长约为
 * `ceil(N / 并发数) × 单条时长`，而单条内部的 4 个 Agent 本来就是并行的，
 * 不需要再动。
 */

/**
 * 同时在跑的选题条数。
 *
 * 🔴 不要随手调大：
 *   · 每条选题内部已经并行打 4 个 DeepSeek 请求 → 3 条 = 12 个并发模型调用；
 *   · 生产机只有 2 vCPU / ~2GB 内存；没有「选题页已提取脚本」的旧窗口
 *     （>7 天）还会在请求里现场 ffmpeg 抽音频，并发过高会互相抢 CPU 反而更慢；
 *   · 线上 nginx 已开 HTTP/2，浏览器连接数不是瓶颈；但 3 条 ≈ 12 个并发模型调用，
 *     再高会显著放大 DeepSeek 429 / 超时的概率。
 * 线上若观察到 DeepSeek 429 / 超时，先降到 2，而不是去改请求结构。
 *
 * 与选题页提脚本的 `MAX_VIDEO_CONCURRENCY`（3）保持一致，便于统一心智模型。
 */
export const CONTENT_TOPIC_CONCURRENCY = 3;

/**
 * 单条选题的**前端看门狗**（毫秒）。
 *
 * 为什么需要：一条卡死的请求会一直占着并发槽位；并发 3 时只要 3 条同时卡住，
 * 整批就再也不动了（界面一直「生成中」，两个按钮都禁用）。服务端自己有单次
 * 120s 的 HTTP 超时与各 provider 预算，但最坏情况（多 provider 依次回退）会超过它，
 * 而 nginx `proxy_read_timeout` 是 600s。这里取 6 分钟：足够覆盖服务端正常的最长链路，
 * 又能在 nginx 之前把槽位释放出来。超时按「这一条失败」处理，不连坐其他条。
 */
export const CONTENT_TOPIC_TIMEOUT_MS = 6 * 60 * 1000;

/** 结果合并只关心这三个字段（不与 ContentPage 的完整类型耦合）。 */
export type WorkflowGroupLike = {
  id?: string;
  shareLink?: string;
  result?: {
    titles?: unknown[];
    hooks?: unknown[];
    scripts?: unknown[];
  };
};

/** 链接比较：去首尾空白后全等。空链接永远不相等（避免把空结果匹配成任意条目）。 */
export const sameLink = (a?: string, b?: string): boolean => {
  const left = String(a || "").trim();
  const right = String(b || "").trim();
  if (!left || !right) return false;
  return left === right;
};

/**
 * 有任意一类产物才算「这条生成成功」——空 payload 不能被当成可复用结果。
 *
 * 导出给 `ContentPage` 用：SSE 收到 Done 但三类产物全空时，要如实记成失败，
 * 否则 effect 里「还有缺结果的链接」会一直成立，可能触发反复自动重跑（白烧模型调用）。
 */
export const hasWorkflowResult = (group?: WorkflowGroupLike | null): boolean => {
  const result = group?.result;
  return Boolean(
    result &&
      ((Array.isArray(result.titles) && result.titles.length > 0) ||
        (Array.isArray(result.hooks) && result.hooks.length > 0) ||
        (Array.isArray(result.scripts) && result.scripts.length > 0)),
  );
};

/**
 * 哪些已有结果可以直接复用（不重新调模型）。
 *
 * 按 `links` 的顺序一一对应取，**一个已有分组最多只用一次**：同一链接重复出现
 * 或两条链接的 `shareLink` 相同，都不会把同一份结果复制给两条选题。
 */
export const pickReusableWorkflowGroups = <T extends WorkflowGroupLike>(
  links: readonly string[],
  groups: readonly T[],
): T[] => {
  const used = new Set<number>();
  return links
    .map((link, index) => {
      const groupIndex = groups.findIndex((group, candidateIndex) =>
        !used.has(candidateIndex) && sameLink(group.shareLink, link) && hasWorkflowResult(group),
      );
      if (groupIndex < 0) return null;
      used.add(groupIndex);
      return {
        ...groups[groupIndex],
        id: `link-${index + 1}`,
        shareLink: link,
      };
    })
    .filter(Boolean) as T[];
};

/**
 * 按「选项的原始顺序」重排结果，并重新编号成 `link-1..N`。
 *
 * 并发之后结果会**乱序完成**，但界面上的位置必须稳定对应勾选顺序；
 * 同时失败/未完成的条目直接缺席（不能把后面的结果往前挤，否则
 * `activeGroupIndex` 与 `selectedTopics` 会错位成「张三的卡片显示李四的内容」）。
 */
export const orderWorkflowGroupsByLinks = <T extends WorkflowGroupLike>(
  links: readonly string[],
  groups: readonly T[],
): T[] => {
  const used = new Set<number>();
  return links
    .map((link, index) => {
      const groupIndex = groups.findIndex((group, candidateIndex) =>
        !used.has(candidateIndex) && sameLink(group.shareLink, link) && hasWorkflowResult(group),
      );
      if (groupIndex < 0) return null;
      used.add(groupIndex);
      return {
        ...groups[groupIndex],
        id: `link-${index + 1}`,
        shareLink: link,
      };
    })
    .filter(Boolean) as T[];
};

/**
 * 按 link 找回某条结果在数组里的位置（找不到返回 -1）。
 *
 * 并发完成后数组会重排：界面用「当前卡片下标」做状态，如果不跟着重定位，
 * 用户正在看的卡片会突然换成另一条，已勾选的标题/钩子也会被清空。
 */
export const findWorkflowGroupIndex = (groups: readonly WorkflowGroupLike[], link?: string): number =>
  groups.findIndex(group => sameLink(group.shareLink, link));

/**
 * 是否是「继续跑剩下几条也只会一起失败」的错误。
 *
 * 🔴 必须是**显式白名单**，不能用 `/_MISSING$/` 这种粗规则：
 * 服务端不少 `*_MISSING` 是**单条选题**的问题 —— `VIDEO_URL_MISSING`（链接被删/私密，
 * 解析不到直链）、`WECHAT_MEDIA_URL_MISSING` / `WECHAT_DECODE_KEY_MISSING`（某条视频号的
 * 解密信息缺失），把它们当致命会**一条坏链接停掉整批**，正是并发要避免的事。
 *
 * 只有「所有选题都会一起失败」的才进白名单：
 *   · 401 / 403：登录态失效，继续跑只会反复触发登出；
 *   · DeepSeek 凭证缺失：每条选题的 4 个创作 Agent 都要用它。
 * 其他 provider 的凭证缺失（TikHub / 豆包 ASR 等）只影响「需要现场解析/转写」的选题，
 * 已经带着选题页脚本过来的条目不经过那两步，所以按单条失败处理。
 */
const FATAL_ERROR_CODES = new Set([
  "DEEPSEEK_TOKEN_MISSING",
  "DEEPSEEK_CREDENTIALS_MISSING",
]);

export const isFatalWorkflowError = (error: unknown): boolean => {
  const status = Number((error as any)?.status || 0);
  const code = String((error as any)?.code || "");
  if (status === 401 || status === 403) return true;
  return FATAL_ERROR_CODES.has(code);
};
