import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as Vue from 'vue';
import { normalizeAlbumCoverId } from '../src/renderer/utils/albumDynamicCover.ts';

const source = readFileSync(
  new URL('../src/renderer/components/music/DynamicAlbumCover.vue', import.meta.url),
  'utf8',
);
const { descriptor } = parse(source);
const code = transformSync(compileScript(descriptor, { id: 'dynamic-cover-test' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const flush = async () => {
  for (let i = 0; i < 4; i++) await Vue.nextTick();
};
const cover = (id) => ({
  albumId: String(id),
  urls: [`https://example.com/${id}.mp4`, `https://example.com/${id}-backup.mp4`],
});

function setup(loader = async (id) => cover(id)) {
  const visible = Vue.ref(true);
  const documentVisibility = Vue.ref('visible');
  const reducedMotion = Vue.ref('no-preference');
  const hooks = {};
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (name === 'vue')
        return {
          ...Vue,
          onActivated: (fn) => {
            hooks.activate = fn;
          },
          onDeactivated: (fn) => {
            hooks.deactivate = fn;
          },
          onBeforeUnmount: (fn) => {
            hooks.unmount = fn;
          },
        };
      if (name === '@vueuse/core')
        return {
          useElementVisibility: () => visible,
          useDocumentVisibility: () => documentVisibility,
          usePreferredReducedMotion: () => reducedMotion,
        };
      if (name === '@/services/albumDynamicCover') return { loadAlbumDynamicCover: loader };
      if (name === '@/utils/albumDynamicCover') return { normalizeAlbumCoverId };
      if (name === '@/components/ui/Cover.vue') return {};
      throw new Error(`Unexpected dependency ${name}`);
    },
    module,
    module.exports,
  );
  const props = Vue.reactive({ albumAudioId: '1', albumId: '', active: true, enabled: true });
  const scope = Vue.effectScope();
  const state = scope.run(() => module.exports.default.setup(props, { expose() {} }));
  const dispose = () => {
    hooks.unmount();
    scope.stop();
  };
  return { state, props, visible, documentVisibility, reducedMotion, hooks, dispose };
}
function video(src) {
  return Vue.markRaw({
    src,
    muted: false,
    paused: true,
    playCalls: 0,
    releases: 0,
    play() {
      this.playCalls++;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    getAttribute() {
      return this.src;
    },
    removeAttribute() {
      this.src = '';
    },
    load() {
      this.releases++;
    },
  });
}

test('late cover responses cannot replace a newer song or resume a hidden page', async () => {
  const pending = new Map();
  const e = setup((id) => new Promise((resolve) => pending.set(id, resolve)));
  e.props.albumAudioId = '2';
  await flush();
  pending.get('2')(cover(2));
  await flush();
  assert.equal(e.state.videoUrl.value, cover(2).urls[0]);
  pending.get('1')(cover(1));
  await flush();
  assert.equal(e.state.videoUrl.value, cover(2).urls[0]);
  e.props.albumAudioId = '3';
  assert.equal(e.state.videoUrl.value, '', 'old video clears synchronously on song change');
  await flush();
  e.documentVisibility.value = 'hidden';
  await flush();
  pending.get('3')(cover(3));
  await flush();
  assert.equal(e.state.videoUrl.value, '');
  e.dispose();
});

test('a response queued in the same turn as a song change cannot restore stale artwork', async () => {
  const pending = new Map();
  const e = setup((id) => new Promise((resolve) => pending.set(id, resolve)));
  pending.get('1')(cover(1));
  e.props.albumAudioId = '2';
  await flush();
  assert.equal(e.state.videoUrl.value, '');
  pending.get('2')(cover(2));
  await flush();
  assert.equal(e.state.videoUrl.value, cover(2).urls[0]);
  e.dispose();
});

test('music pause, offscreen, background and KeepAlive deactivation pause muted video', async () => {
  const e = setup();
  await flush();
  const v = video(e.state.videoUrl.value);
  e.state.videoRef.value = v;
  await flush();
  assert.equal(v.paused, false);
  assert.equal(v.muted, true);
  for (const [hide, show] of [
    [
      () => {
        e.props.active = false;
      },
      () => {
        e.props.active = true;
      },
    ],
    [
      () => {
        e.visible.value = false;
      },
      () => {
        e.visible.value = true;
      },
    ],
    [
      () => {
        e.documentVisibility.value = 'hidden';
      },
      () => {
        e.documentVisibility.value = 'visible';
      },
    ],
    [e.hooks.deactivate, e.hooks.activate],
  ]) {
    hide();
    await flush();
    assert.equal(v.paused, true);
    show();
    await flush();
    assert.equal(v.paused, false);
  }
  e.dispose();
  assert.equal(v.paused, true);
  assert.equal(v.src, '');
  assert.equal(v.releases, 1);
});

test('turning off motion uses static cover and re-enabling waits for a fresh playing frame', async () => {
  const e = setup();
  await flush();
  const v = video(e.state.videoUrl.value);
  e.state.videoRef.value = v;
  await flush();
  e.state.handlePlaying({ currentTarget: v });
  assert.equal(e.state.ready.value, true);
  e.props.enabled = false;
  await flush();
  assert.equal(e.state.videoUrl.value, '');
  assert.equal(v.paused, true);
  assert.equal(e.state.ready.value, false);
  e.props.enabled = true;
  await flush();
  assert.equal(e.state.ready.value, false);
  e.reducedMotion.value = 'reduce';
  await flush();
  assert.equal(e.state.videoUrl.value, '');
  assert.equal(v.paused, true);
  e.dispose();
});

test('duplicate error notifications advance to the backup once; exhausted sources stay static', async () => {
  const e = setup();
  await flush();
  const first = video(e.state.videoUrl.value);
  e.state.videoRef.value = first;
  await flush();
  e.state.handleError({ currentTarget: first });
  e.state.handleError({ currentTarget: first });
  assert.equal(e.state.videoUrl.value, cover(1).urls[1]);
  const second = video(e.state.videoUrl.value);
  e.state.videoRef.value = second;
  await flush();
  assert.equal(first.src, '', 'release old video when changing source');
  e.state.handleError({ currentTarget: first });
  assert.equal(e.state.videoUrl.value, cover(1).urls[1]);
  e.state.handleError({ currentTarget: second });
  assert.equal(e.state.videoUrl.value, '');
  e.dispose();
});
