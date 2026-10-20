import test from 'node:test';
import assert from 'node:assert/strict';
import { filterExportDrafts, sameDraftTopic, pickDraftExportBlock, hasDraftExportContent, buildPublishExport, withCurrentPublishSelection, editorPayloadFromDraft, compactTopicLabel, sameDraftSelection } from '../../web/src/app/draftExport.ts';
import { buildFinalDraftMarkdown } from '../api/_lib/exportFormatters.js';
import { finalDraftToBitableRecords } from '../api/_lib/feishuClient.js';

const draft = { customerId: 'c1', taskId: 't1', topic: { id: 'v1', shareLink: 'https://example.test/1' }, scriptDraft: '本条正文', titleDraft: '本条标题', publishWarehouse: { coverUrl: 'https://example.test/image.png', copy: '发布文案', tags: '#标签' } };

test('当前批次导出排除其它客户、任务、选题和身份不明的旧稿，不改变原列表', () => {
  const rows = [draft, { ...draft, taskId: 't2' }, { ...draft, customerId: 'c2' }, { ...draft, topic: { id: 'v2' } }, { scriptDraft: '无归属旧稿' }];
  assert.deepEqual(filterExportDrafts(rows, { customerId: 'c1', taskId: 't1', topics: [{ id: 'v1' }] }), [draft]);
  assert.equal(rows.length, 5);
});
test('已知选题ID不一致时，即使链接相同也不能沿用交接稿', () => {
  assert.equal(sameDraftTopic(draft, { id: 'v2', link: draft.topic.shareLink }), false);
  assert.equal(sameDraftTopic(draft, { id: 'v1' }), true);
  assert.equal(sameDraftTopic({ topic: {} }, {}), false);
});
test('未改勾选只切换浏览位置不应覆盖人工定稿，改变勾选则需要重新保存', () => {
  const selection = { selectedTitles: ['标题'], selectedScripts: ['s1'], rewriteEnabled: false, rewriteTarget: '' };
  assert.equal(sameDraftSelection(selection, { ...selection, sourceGroupIndex: 2, rewriteTarget: 'douyin' }), true);
  assert.equal(sameDraftSelection(selection, { ...selection, selectedScripts: ['s2'] }), false);
  assert.equal(sameDraftSelection(undefined, selection), false);
});
test('二创、封面、文案和标签导出互不夹带其它块，原稿保持不变', () => {
  const content = pickDraftExportBlock(draft, 'content');
  assert.equal(content.scriptDraft, '本条正文');
  assert.equal(content.publishWarehouse, undefined);
  for (const block of ['cover', 'copy', 'tags']) {
    const item = pickDraftExportBlock(draft, block);
    assert.equal(item.scriptDraft, undefined);
    assert.equal(hasDraftExportContent(item, block), true);
    if (block !== 'copy') assert.equal(item.publishWarehouse.copy, undefined);
    if (block !== 'tags') assert.equal(item.publishWarehouse.tags, undefined);
  }
  assert.equal(draft.publishWarehouse.copy, '发布文案');
});
test('分块文档只包含对应发布段落，多维表格保留当前选题的来源', () => {
  const item = pickDraftExportBlock({ ...draft, topic: { ...draft.topic, title: '当前选题' } }, 'copy');
  const markdown = buildFinalDraftMarkdown(item);
  assert.match(markdown, /发布文案/);
  assert.doesNotMatch(markdown, /二创文案|发布封面|发布标签|未提供/);
  const records = finalDraftToBitableRecords(item);
  assert.equal(records[0].fields['对标视频标题'], '当前选题');
  assert.equal(records[0].fields['发布仓（发布文案＋发布标签）'], '发布文案');
});
test('只出已选封面、已选文案和已确认标签，dataUrl不进入导出载荷', () => {
  const selection = { cover: { selectedId: 'b', candidates: [{ id: 'a', image: { url: 'https://example.test/a' } }, { id: 'b', title: 'B', image: { dataUrl: 'data:image/png;base64,AAA' } }] }, publishCopy: { selected: ['选中稿'] }, topicTags: { selected: ['标签', '#标签'] } };
  const output = buildPublishExport(selection, { track: '固定标签' });
  assert.equal(output.coverUrl, '');
  assert.equal(output.coverInline, true);
  assert.equal(output.coverTitle, 'B');
  assert.equal(output.copy, '选中稿');
  assert.equal(output.tags, '#固定标签 #标签');
  assert.equal(JSON.stringify(output).includes('base64'), false);
  assert.equal(hasDraftExportContent({ publishWarehouse: { coverTitle: '只有标题' } }, 'cover'), false);
});
test('导出补齐发布仓已选材料，但不覆盖更晚的最终人工编辑', () => {
  const selection = { updatedAt: '2026-10-20T02:00:00Z', publishCopy: { selected: ['新选择'] } };
  assert.equal(withCurrentPublishSelection({ ...draft, publishWarehouse: null }, selection, {}).publishWarehouse.copy, '新选择');
  assert.equal(withCurrentPublishSelection({ ...draft, updatedAt: '2026-10-20T03:00:00Z' }, selection, {}).publishWarehouse.copy, '发布文案');
  assert.equal(withCurrentPublishSelection({ ...draft, updatedAt: '2026-10-20T01:00:00Z' }, selection, {}).publishWarehouse.copy, '新选择');
});
test('恢复最终编辑使用当前选题正文和身份，长标题仅缩短展示', () => {
  const long = '😀英文中文'.repeat(300);
  const source = { ...draft, topic: { id: 'v1', title: long } };
  const payload = editorPayloadFromDraft(source, { id: 'group1', index: 1, total: 2 });
  assert.equal(payload.scriptDraft, draft.scriptDraft);
  assert.equal(payload.topic.title, long);
  assert.equal(payload.sourceGroupIndex, 1);
  assert.deepEqual(payload.publishWarehouse, draft.publishWarehouse);
  assert.equal(Array.from(compactTopicLabel(long)).length, 57);
  assert.equal(source.topic.title, long);
});
