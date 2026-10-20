import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DRAFT_ITEMS,
  buildDraftItem,
  clearDraftItems,
  deleteDraftItem,
  draftHasContent,
  draftScopeKey,
  listDraftItems,
  normalizeDraftSelection,
  upsertDraftItems,
} from "../api/_lib/draftItems.js";

/**
 * 最终文案草稿的「按选题保存」契约测试（2026-10-19）。
 *
 * 这些不变量出错时界面都看着正常：
 *   · 同一选题重复保存 → 导出里出现多份几乎一样的记录；
 *   · 不同选题互相覆盖 → 用户以为「保存了，记录没了」；
 *   · owner 过滤失效 → 同浏览器换账号能看到别人的内容；
 *   · 发布仓字段被内容页的保存冲掉 → 封面/发布文案/标签静默消失。
 */

const topicA = { id: "topic-a", title: "选题 A", shareLink: "https://v.douyin.com/a", platform: "douyin" };
const topicB = { id: "topic-b", title: "选题 B", shareLink: "https://v.douyin.com/b", platform: "douyin" };

const draftBody = (overrides = {}) => ({
  customerId: "cust-1",
  taskId: "task-1",
  topic: topicA,
  titleDraft: "1. 标题 A",
  hookDraft: "1. 三秒 A",
  scriptDraft: "【文案 1】\n二创 A",
  benchmarkVideos: [{ title: "对标 A", link: "https://v.douyin.com/a", likes: 120 }],
  selection: {
    selectedTitles: ["1. 标题 A"],
    selectedHooks: ["hook-opening-1-1"],
    selectedScripts: ["script-1"],
    rewriteEnabled: true,
    translationEnabled: false,
    sourceGroupId: "link-1",
    sourceGroupIndex: 0,
    totalGroups: 3,
  },
  ...overrides,
});

test("同一选题再保存 = 更新：不新增、id/创建时间稳定、内容更新", () => {
  const first = buildDraftItem(draftBody(), "user-1");
  let items = upsertDraftItems([], first);
  assert.equal(items.length, 1);

  const second = buildDraftItem(draftBody({ titleDraft: "1. 新标题 A", updatedAt: undefined }), "user-1");
  items = upsertDraftItems(items, second);

  assert.equal(items.length, 1, "同一 owner+客户+任务+选题只能有一条");
  assert.equal(items[0].id, first.id, "记录 id 不能因为再保存一次而变（否则前端列表会跳）");
  assert.equal(items[0].createdAt, first.createdAt, "createdAt 保留首次保存时间");
  assert.equal(items[0].titleDraft, "1. 新标题 A", "内容必须是新保存的");
  assert.notEqual(items[0].updatedAt, first.updatedAt, "updatedAt 要更新");

  // 不同选题是另一条
  items = upsertDraftItems(items, buildDraftItem(draftBody({ topic: topicB, titleDraft: "1. 标题 B" }), "user-1"));
  assert.equal(items.length, 2);
});

test("内容页再保存不能冲掉发布仓字段 / 已保存的勾选", () => {
  const withPublish = buildDraftItem(draftBody({
    publishWarehouse: { coverUrl: "https://cdn.example.com/c.png", copy: "发布文案", tags: "#标签" },
  }), "user-1");
  let items = upsertDraftItems([], withPublish);

  // 内容页保存：没有 publishWarehouse、selection 为空
  const fromContent = buildDraftItem(draftBody({ publishWarehouse: null, selection: null, titleDraft: "1. 改过的标题" }), "user-1");
  items = upsertDraftItems(items, fromContent);

  assert.equal(items.length, 1);
  assert.equal(items[0].publishWarehouse?.copy, "发布文案", "发布仓产出不能被内容页的保存覆盖成 null");
  assert.equal(items[0].publishWarehouse?.coverUrl, "https://cdn.example.com/c.png");
  assert.equal(items[0].selection?.selectedTitles?.[0], "1. 标题 A", "没带勾选状态时要保留旧的");
  assert.equal(items[0].titleDraft, "1. 改过的标题");
  assert.equal(items[0].scriptDraft, "【文案 1】\n二创 A", "没带的文本段落要保留旧值");
  assert.equal(items[0].hookDraft, "1. 三秒 A");
  assert.equal(items[0].benchmarkVideos.length, 1, "没带对标视频时也要保留旧的");
});

test("不同用户 / 不同客户 / 不同任务互不覆盖，owner 过滤生效", () => {
  let items = [];
  items = upsertDraftItems(items, buildDraftItem(draftBody(), "user-1"));
  items = upsertDraftItems(items, buildDraftItem(draftBody(), "user-2"));
  items = upsertDraftItems(items, buildDraftItem(draftBody({ customerId: "cust-2" }), "user-1"));
  items = upsertDraftItems(items, buildDraftItem(draftBody({ taskId: "task-2" }), "user-1"));

  assert.equal(items.length, 4, "四个作用域各一条，不能互相覆盖");

  const user1 = listDraftItems(items, "user-1");
  assert.equal(user1.length, 3, "user-1 只看到自己的 3 条");
  assert.equal(listDraftItems(items, "user-2").length, 1);
  assert.equal(listDraftItems(items, "user-3").length, 0);

  assert.equal(listDraftItems(items, "user-1", { customerId: "cust-1" }).length, 2);
  assert.equal(listDraftItems(items, "user-1", { customerId: "cust-1", taskId: "task-1" }).length, 1);
});

test("没有 owner 的旧草稿升级后不会凭空消失（但可以被清空）", () => {
  const legacy = { id: "draft_legacy", createdAt: "2026-10-01T00:00:00.000Z", titleDraft: "旧记录" };
  const items = [legacy, buildDraftItem(draftBody(), "user-1")];

  const visible = listDraftItems(items, "user-1");
  assert.equal(visible.length, 2, "旧草稿没有 owner，不能被过滤掉（用户会以为记录丢了）");
  assert.equal(listDraftItems(items, "user-2").length, 1, "旧草稿对升级后的任意用户可见，避免丢数据");

  const cleared = clearDraftItems(items, "user-1");
  assert.equal(cleared.removed, 2, "清空当前用户记录时，旧草稿一并清掉");
  assert.equal(cleared.items.length, 0);
});

test("删除单条只能删自己可见的，别人的 id 删不掉", () => {
  let items = upsertDraftItems([], buildDraftItem(draftBody(), "user-1"));
  items = upsertDraftItems(items, buildDraftItem(draftBody(), "user-2"));

  const user1Id = listDraftItems(items, "user-1")[0].id;
  const user2Id = listDraftItems(items, "user-2")[0].id;

  const denied = deleteDraftItem(items, "user-2", user1Id);
  assert.equal(denied.removed, 0, "不能跨用户删记录");
  assert.equal(denied.items.length, 2);

  const removed = deleteDraftItem(items, "user-2", user2Id);
  assert.equal(removed.removed, 1);
  assert.equal(listDraftItems(removed.items, "user-2").length, 0);
  assert.equal(listDraftItems(removed.items, "user-1").length, 1, "别人的记录不能被牵连");
});

test("上限与归一化：超长文本/超量条目被截断，不会把草稿文件撑爆", () => {
  const item = buildDraftItem(draftBody({
    titleDraft: "x".repeat(50000),
    benchmarkVideos: Array.from({ length: 100 }, (_, index) => ({ title: `视频 ${index}`, link: `https://x/${index}` })),
    selection: {
      selectedTitles: Array.from({ length: 200 }, (_, index) => `标题 ${index}`),
      selectedHooks: Array.from({ length: 500 }, (_, index) => `hook-${index}`),
    },
  }), "user-1");

  assert.ok(item.titleDraft.length <= 20000);
  assert.ok(item.benchmarkVideos.length <= 60);
  assert.ok(item.selection.selectedTitles.length <= 60);
  assert.ok(item.selection.selectedHooks.length <= 120);

  let items = [];
  for (let index = 0; index < MAX_DRAFT_ITEMS + 20; index += 1) {
    items = upsertDraftItems(items, buildDraftItem(draftBody({ topic: { id: `t-${index}` } }), "user-1"));
  }
  assert.equal(items.length, MAX_DRAFT_ITEMS, "超过上限时丢最旧的，而不是无限增长");
});

test("归一化：无关字段不落库，勾选状态形状稳定", () => {
  const selection = normalizeDraftSelection({
    selectedTitles: ["  标题  ", "", null],
    selectedHooks: [" hook-1 ", ""],
    selectedScripts: ["script-1"],
    rewriteResults: [{ id: "rw-1", original: "原文", rewritten: "改写", target: "douyin" }],
    translationItems: [{ id: "t-1", sourceType: "title", zh: "中文", en: "EN" }],
    sourceGroupIndex: 2,
    totalGroups: 4,
    secretToken: "should-not-be-stored",
  });
  assert.deepEqual(selection.selectedTitles, ["标题"]);
  assert.deepEqual(selection.selectedHooks, ["hook-1"]);
  assert.equal(selection.rewriteResults.length, 1);
  assert.equal(selection.translationItems.length, 1);
  assert.equal(selection.sourceGroupIndex, 2);
  assert.equal(selection.totalGroups, 4);
  assert.equal("secretToken" in selection, false);

  assert.equal(draftScopeKey(buildDraftItem(draftBody(), "u")), "u|cust-1|task-1|topic-a");
  assert.equal(draftScopeKey({ ownerId: "u", titleDraft: "没有 topic" }), "", "没有 topic 的旧调用不做 upsert");
});

test("draftHasContent：全空记录不应进入导出", () => {
  assert.equal(draftHasContent(buildDraftItem(draftBody(), "u")), true);
  assert.equal(draftHasContent({ titleDraft: "  ", hookDraft: "" }), false);
  assert.equal(draftHasContent({ selection: { selectedTitles: ["1. 标题"] } }), true);
});
