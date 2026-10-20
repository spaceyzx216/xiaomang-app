import test from "node:test";
import assert from "node:assert/strict";

import { buildFinalDraftMarkdown, buildFinalDraftMarkdownForItems } from "../api/_lib/exportFormatters.js";
import { finalDraftToBitableRecords } from "../api/_lib/feishuClient.js";

/**
 * 导出侧的多条记录契约（2026-10-19）。
 *
 * 背景：PublishWarehouse 一直发 `{ items: [...] }`，但服务端只认单条草稿，
 * 于是「写入飞书文档/多维表格」会得到一篇空文档/一行空记录。内容页要复用导出，
 * 这里把「多条怎么合并」钉住，避免两边再次漂移。
 */

const itemA = {
  titleDraft: "1. 标题A1\n2. 标题A2",
  hookDraft: "1. 三秒A",
  endingHookDraft: "1. 结尾A",
  scriptDraft: "【文案 1】\n二创文案A",
  benchmarkVideos: [{ title: "对标A", link: "https://v.douyin.com/a", likes: 120, script: "原文A" }],
  publishWarehouse: { coverUrl: "https://cdn.example.com/a.png", copy: "发布文案A", tags: "#A" },
};

const itemB = {
  titleDraft: "1. 标题B1",
  hookDraft: "1. 三秒B",
  scriptDraft: "【文案 1】\n二创文案B",
  benchmarkVideos: [{ title: "对标B", link: "https://v.douyin.com/b", likes: 80 }],
};

test("多条草稿合并成一篇文档：每条都有「选题 N」标题，内容都在", () => {
  const markdown = buildFinalDraftMarkdownForItems([itemA, itemB]);
  assert.match(markdown, /选题 1/);
  assert.match(markdown, /选题 2/);
  assert.match(markdown, /标题A1/);
  assert.match(markdown, /标题B1/);
  assert.match(markdown, /二创文案A/);
  assert.match(markdown, /二创文案B/);
  assert.match(markdown, /发布文案A/, "带发布仓产出的条目要保留发布段");
  assert.match(markdown, /#A/);
});

test("单条时与原来的单草稿格式完全一致（不影响旧的单条导出）", () => {
  assert.equal(buildFinalDraftMarkdownForItems([itemA]), buildFinalDraftMarkdown(itemA));
  assert.equal(buildFinalDraftMarkdownForItems([]), buildFinalDraftMarkdown({}));
});

test("发布仓产出不会串到没经过发布仓的条目上", () => {
  const markdown = buildFinalDraftMarkdownForItems([itemA, itemB]);
  const second = markdown.split("选题 2")[1] || "";
  assert.equal(second.includes("发布文案A"), false);
  assert.equal(second.includes("发布仓（发布文案＋发布标签）"), false);
});

test("多维表格单条记录：没有 benchmarkVideos 时也有一条兜底行，不能是空记录", () => {
  const records = finalDraftToBitableRecords({ titleDraft: "1. 只有标题", scriptDraft: "文案" });
  assert.equal(records.length, 1);
  assert.equal(records[0].fields["对标视频标题"], "只有标题");
  assert.equal(records[0].fields["原二创文案"], "文案");
});

test("多维表格单条记录：有 benchmarkVideos 时按视频展开，且把原文案带进去", () => {
  const records = finalDraftToBitableRecords(itemA);
  assert.equal(records.length, 1);
  assert.equal(records[0].fields["对标视频标题"], "对标A");
  assert.equal(records[0].fields["原文案"], "原文A");
  assert.equal(records[0].fields["生成3秒"], "1. 三秒A");
  assert.equal(records[0].fields["生成结尾钩子"], "1. 结尾A");
});
