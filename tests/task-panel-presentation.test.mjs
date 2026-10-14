import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse, compileScript } from '@vue/compiler-sfc';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const { descriptor } = parse(
  readFileSync('src/renderer/components/tasks/TaskPanelDialog.vue', 'utf8'),
);
const code = transformSync(compileScript(descriptor, { id: 'task-presentation' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', code)(
  (id) => (id === 'vue' ? vue : {}),
  module,
  module.exports,
);
const { progressPercent } = module.exports.default.setup({}, { expose() {} });

test('plugin tasks can report counts without supplying their own percentage', () => {
  assert.equal(progressPercent({ progress: { done: 4, total: 10 } }), 40);
  assert.equal(progressPercent({ progress: { done: 1, total: 3 } }), 33.3);
  assert.equal(progressPercent({ progress: { done: 10, total: 10 } }), 100);
});

test('explicit percentage takes precedence and unknown totals stay indeterminate', () => {
  assert.equal(progressPercent({ progress: { percent: 55, done: 4, total: 10 } }), 55);
  assert.equal(progressPercent({ progress: { percent: 0, done: 4, total: 10 } }), 0);
  assert.equal(progressPercent({ progress: { done: 0, total: 0 } }), null);
  assert.equal(progressPercent({ progress: { label: '扫描目录中' } }), null);
  assert.equal(progressPercent({}), null);
});

test('invalid plugin progress does not create invalid progress bar geometry', () => {
  assert.equal(progressPercent({ progress: { percent: Number.NaN, done: 2, total: 4 } }), 50);
  assert.equal(progressPercent({ progress: { percent: Infinity } }), null);
  assert.equal(progressPercent({ progress: { done: 8, total: 4 } }), 100);
  assert.equal(progressPercent({ progress: { done: -1, total: 4 } }), 0);
});
