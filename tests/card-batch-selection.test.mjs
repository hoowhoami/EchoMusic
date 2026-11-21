import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const load = async () => {
  const outdir = mkdtempSync(path.join(tmpdir(), 'echo-card-batch-'));
  const outfile = path.join(outdir, 'cardBatchSelection.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/utils/cardBatchSelection.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return mod.default ?? mod;
};

const helpers = await load();

test('isKeySelected: 只认字符串 key 完全相等', () => {
  assert.equal(helpers.isKeySelected(['1', '22'], '1'), true);
  assert.equal(helpers.isKeySelected(['1', '22'], '2'), false);
  assert.equal(helpers.isKeySelected([], '1'), false);
});

test('toggleKey: 未选则追加到末尾，已选则只移除自己', () => {
  assert.deepEqual(helpers.toggleKey([], 'a'), ['a']);
  assert.deepEqual(helpers.toggleKey(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(helpers.toggleKey(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(helpers.toggleKey(['a', 'a', 'b'], 'a'), ['b']);
});

test('toggleKey: 不改动传入数组，保持点击顺序', () => {
  const selected = ['c', 'a'];
  const next = helpers.toggleKey(selected, 'b');
  assert.deepEqual(selected, ['c', 'a']);
  assert.deepEqual(next, ['c', 'a', 'b']);
});

test('isAllSelected: 空列表不算全选', () => {
  assert.equal(helpers.isAllSelected([], 0), false);
  assert.equal(helpers.isAllSelected(['a'], 0), false);
  assert.equal(helpers.isAllSelected([], 2), false);
  assert.equal(helpers.isAllSelected(['a', 'b'], 2), true);
});

test('toggleAllKeys: 未全选则全选，已全选则清空', () => {
  assert.deepEqual(helpers.toggleAllKeys([], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(helpers.toggleAllKeys(['b'], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(helpers.toggleAllKeys(['a', 'b'], ['a', 'b']), []);
});

test('toggleAllKeys: 没有可选项时保持清空', () => {
  assert.deepEqual(helpers.toggleAllKeys([], []), []);
});

test('CardBatchDrawer 用共享纯函数管理选中，不再自己实现集合逻辑', () => {
  const source = readFileSync(
    path.join(root, 'src/renderer/components/music/CardBatchDrawer.vue'),
    'utf8',
  );
  assert.match(source, /from '@\/utils\/cardBatchSelection'/);
  assert.match(source, /isAllSelected\(selectedKeys\.value, props\.items\.length\)/);
  assert.match(source, /toggleKey\(selectedKeys\.value, item\.key\)/);
  assert.match(source, /toggleAllKeys\(/);
  assert.ok(!source.includes('selectedKeys.value.includes('), '选中判定不该再散落在组件里');
});

test('收藏页批量取消视频前先确认已收藏，避免 toggle 反向收藏', () => {
  // 仓库里部分文件是 CRLF，先归一化再按行匹配
  const source = readFileSync(path.join(root, 'src/renderer/views/Favorites.vue'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );
  const branch =
    /else \{\n\s*\/\/ 收藏页里的卡片[^\n]*\n\s*await videoCollectionStore\.ensureLoaded\(\);\n\s*if \(videoCollectionStore\.isCollected\(key\)\)/.exec(
      source,
    );
  assert.ok(branch, '批量取消收藏分支应先 ensureLoaded + isCollected 再 toggle');
});
