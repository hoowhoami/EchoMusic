import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';

const compile = (path, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
};

const constants = compile('../src/renderer/stores/playlist/constants.ts');
const songUtils = compile('../src/renderer/utils/song.ts');
const helpers = compile('../src/renderer/stores/playlist/helpers.ts', {
  '../../../shared/embeddedMetadata': embeddedTags,
  vue,
  '@/utils/song': songUtils,
  './constants': constants,
});

const queueWithScope = (scope) =>
  helpers.buildPlaybackQueueState({
    queueId: 'queue:album:193367568',
    title: '夜的命名术',
    type: 'album',
    resumeScope: scope,
  });

/** 模拟落库再读回：内存里的 resumeScope 不在存储层字段里，只能靠 meta 带回来。 */
const roundTrip = (queue) => {
  const stored = JSON.parse(JSON.stringify({ ...queue, meta: helpers.withResumeScopeMeta(queue) }));
  delete stored.resumeScope;
  return helpers.normalizePlaybackQueueRuntime(stored);
};

test('队列归属镜像进 meta 并随水合还原', () => {
  const scope = { kind: 'audiobook', id: '193367568' };
  const queue = queueWithScope(scope);
  const restored = roundTrip(queue);
  assert.deepEqual(restored.resumeScope, scope);
  assert.equal(restored.meta.resumeScopeKind, 'audiobook');
  assert.equal(restored.meta.resumeScopeId, '193367568');
});

test('没有归属的队列不写镜像键，水合后仍为空', () => {
  const queue = queueWithScope(null);
  assert.equal(queue.meta.resumeScopeKind, undefined);
  const restored = roundTrip(queue);
  assert.equal(restored.resumeScope ?? null, null);
});

test('归属换到另一页会被覆盖，不会留旧键', () => {
  const first = queueWithScope({ kind: 'album', id: '100' });
  assert.equal(helpers.withResumeScopeMeta(first).resumeScopeId, '100');
  first.resumeScope = { kind: 'playlist', id: '200' };
  const meta = helpers.withResumeScopeMeta(first);
  assert.equal(meta.resumeScopeKind, 'playlist');
  assert.equal(meta.resumeScopeId, '200');
  first.resumeScope = null;
  const cleared = helpers.withResumeScopeMeta(first);
  assert.equal('resumeScopeKind' in cleared, false);
  assert.equal('resumeScopeId' in cleared, false);
});

test('meta 里的坏值不会被当成归属', () => {
  const queue = queueWithScope(null);
  queue.meta.resumeScopeKind = 'bogus';
  queue.meta.resumeScopeId = '100';
  assert.equal(helpers.normalizePlaybackQueueRuntime(queue).resumeScope ?? null, null);

  const emptyId = queueWithScope(null);
  emptyId.meta.resumeScopeKind = 'album';
  emptyId.meta.resumeScopeId = '';
  assert.equal(helpers.normalizePlaybackQueueRuntime(emptyId).resumeScope ?? null, null);
});

test('内存里已有的归属不会被动过', () => {
  const queue = queueWithScope({ kind: 'artist', id: '77' });
  queue.meta.resumeScopeKind = 'album';
  queue.meta.resumeScopeId = '99';
  assert.deepEqual(helpers.normalizePlaybackQueueRuntime(queue).resumeScope, {
    kind: 'artist',
    id: '77',
  });
});
