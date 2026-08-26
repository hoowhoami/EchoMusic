import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as support from '../src/shared/audio-effect-support.ts';

const ir = {
  id: 'ir',
  name: '卷积',
  kind: 'community-ir',
  impulseResponsePath: '/ir.wav',
  size: 1,
  importedAt: 1,
};
const vpf = {
  id: 'vpf',
  name: '参数',
  kind: 'community-vpf',
  vpfPath: '/effect.vpf',
  size: 1,
  importedAt: 1,
};
const combined = {
  ...ir,
  id: 'both',
  name: '组合',
  kind: 'community-combined',
  vpfPath: vpf.vpfPath,
};
const manifest = {
  schemaVersion: 1,
  resources: [
    { kind: 'impulse-response', extensions: ['.wav', '.irs'] },
    { kind: 'vpf', extensions: ['.vpf'] },
  ],
};
const provider = { kind: 'provider', manifest };

function loadModule(path, imports) {
  const { code } = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in imports, `unmocked import ${name}`);
      return imports[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}
const { createSpatialAudioSupport } = loadModule(
  '../src/renderer/stores/player/spatialAudioSupport.ts',
  {
    vue,
    '../../../shared/audio-effect-support': support,
  },
);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  await Promise.resolve();
  await vue.nextTick();
};
function fixture(t, { file = combined, path = '/A', enabled = true } = {}) {
  const state = vue.reactive({ path, mode: 'speaker', file, enabled, graph: null, preset: '' });
  const requests = [],
    warnings = [];
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  const manager = scope.run(() =>
    createSpatialAudioSupport({
      providerPath: () => state.path || undefined,
      providerMode: () => state.mode,
      graph: () => state.graph,
      selected: () => state.file,
      enabled: () => state.enabled,
      inspect: (path) => {
        const job = deferred();
        requests.push({ path, ...job });
        return job.promise;
      },
      unsupported: (file, reason) => {
        warnings.push({ id: file.id, reason });
        state.enabled = false;
        state.preset = '';
      },
    }),
  );
  const command = () =>
    support.spatialAudioEffectOptions({
      providerPath: state.path || undefined,
      providerMode: state.mode,
      providerPresetJson: state.preset || undefined,
      enabled: state.enabled,
      file: state.file,
      support: state.file ? manager.support(state.file) : undefined,
    });
  return { state, manager, requests, warnings, command, scope };
}
const inspection = (value = manifest) => ({ manifestJson: JSON.stringify(value) });
const graph = (path, value = manifest, mode = 'speaker') => ({
  providerPath: path,
  providerId: path,
  providerMode: mode,
  providerManifestJson: JSON.stringify(value),
});

test('builtin accepts IR but never VPF or half of a combined effect', () => {
  assert.equal(support.audioEffectSupport(ir, { kind: 'builtin' }).status, 'supported');
  for (const file of [vpf, combined]) {
    const status = support.audioEffectSupport(file, { kind: 'builtin' });
    assert.equal(status.status, 'unsupported');
    assert.equal(
      support.spatialAudioEffectOptions({
        file,
        enabled: true,
        providerMode: 'speaker',
        support: status,
      }),
      null,
    );
  }
});
test('each required kind AND extension must be supported; combined resources are atomic', () => {
  for (const file of [ir, vpf, combined])
    assert.equal(support.audioEffectSupport(file, provider).status, 'supported');
  for (const resources of [[manifest.resources[0]], [manifest.resources[1]], []]) {
    const result = support.audioEffectSupport(combined, {
      kind: 'provider',
      manifest: { resources },
    });
    assert.equal(result.status, 'unsupported');
    assert.deepEqual(
      support.spatialAudioEffectOptions({
        file: combined,
        enabled: true,
        providerPath: '/A',
        providerMode: 'speaker',
        support: result,
      }),
      { providerPath: '/A', providerMode: 'speaker' },
    );
  }
  assert.equal(
    support.audioEffectSupport({ ...ir, impulseResponsePath: '/audio.flac' }, provider).status,
    'unsupported',
  );
  assert.equal(
    support.audioEffectSupport({ ...ir, impulseResponsePath: 'C:\\音效\\A.WAV' }, provider).status,
    'supported',
  );
  assert.equal(
    support.audioEffectSupport(vpf, {
      kind: 'provider',
      manifest: { resources: [{ kind: 'other', extensions: ['.vpf'] }] },
    }).status,
    'unsupported',
  );
});
test('missing resources, invalid manifests and unknown support fail closed', () => {
  for (const value of ['', '{bad', 'null', '[]'])
    assert.equal(support.parseAudioEffectManifest(value), null);
  for (const file of [
    { ...combined, vpfPath: '' },
    { ...combined, impulseResponsePath: '' },
  ])
    assert.equal(support.audioEffectSupport(file, provider).status, 'unsupported');
  for (const manifest of [
    null,
    {},
    { resources: 'vpf' },
    { resources: [null, { kind: 1 }, { kind: 'vpf', extensions: 1 }] },
  ])
    assert.equal(
      support.audioEffectSupport(vpf, { kind: 'provider', manifest }).status,
      'unsupported',
    );
  assert.equal(support.audioEffectSupport(combined, { kind: 'checking' }).status, 'checking');
});
test('supported command includes both resources and drops previous engine preset', () => {
  const result = support.spatialAudioEffectOptions({
    file: combined,
    enabled: true,
    providerPath: '/A',
    providerMode: 'speaker',
    providerPresetJson: '{"presetId":"old"}',
    support: support.audioEffectSupport(combined, provider),
  });
  assert.deepEqual(result.providerResources, [
    { kind: 'vpf', path: '/effect.vpf' },
    { kind: 'impulse-response', path: '/ir.wav' },
  ]);
  assert.equal(result.providerPresetJson, undefined);
});
test('startup does not clear a saved selection before capabilities resolve', async (t) => {
  const f = fixture(t);
  const saved = f.state.file;
  assert.equal(f.manager.support(combined).status, 'checking');
  const started = f.manager.start();
  assert.equal(f.state.enabled, true);
  assert.equal(f.command().providerResources, undefined);
  f.requests[0].resolve(inspection());
  await started;
  assert.equal(f.state.enabled, true);
  assert.equal(f.state.file, saved);
  assert.equal(f.command().providerResources.length, 2);
  assert.deepEqual(f.warnings, []);
});
test('unsupported startup returns to original once, keeps files and does not disable the engine', async (t) => {
  const f = fixture(t);
  const saved = f.state.file;
  const started = f.manager.start();
  f.requests[0].resolve(inspection({ resources: [] }));
  await started;
  assert.equal(f.state.enabled, false);
  assert.equal(f.state.file, saved);
  assert.equal(f.state.path, '/A');
  assert.equal(f.warnings.length, 1);
  assert.equal(f.command().providerResources, undefined);
  f.state.graph = graph('/A', { resources: [] });
  await settle();
  assert.equal(f.warnings.length, 1);
  f.state.graph = graph('/A');
  await settle();
  assert.equal(f.state.enabled, false);
});

test('canceling a saved selection while checking is not undone by a successful inspection', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.state.enabled = false;
  f.requests[0].resolve(inspection());
  await started;
  assert.equal(f.state.enabled, false);
  assert.equal(f.command().providerResources, undefined);
  assert.equal(f.warnings.length, 0);
});
test('disabled engine restores pure IR through builtin, but clears a selected combination', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.requests[0].resolve(inspection());
  await started;
  f.state.path = '';
  await settle();
  assert.equal(f.state.enabled, false);
  assert.equal(f.command(), null);
  assert.equal(f.warnings.length, 1);
  const plain = fixture(t, { file: ir, path: '' });
  await plain.manager.start();
  assert.equal(plain.state.enabled, true);
  assert.equal(plain.command().impulseResponsePath, '/ir.wav');
});
test('engine switch ignores previous runtime manifest and late inspection result', async (t) => {
  const f = fixture(t);
  const startA = f.manager.start();
  f.state.path = '/B';
  f.state.graph = graph('/A', { resources: [] });
  assert.equal(f.manager.support(combined).status, 'checking');
  assert.equal(f.state.enabled, true);
  f.requests[1].resolve(inspection());
  await settle();
  f.requests[0].resolve(inspection({ resources: [] }));
  await startA;
  assert.equal(f.manager.support(combined).status, 'supported');
  assert.equal(f.state.enabled, true);
  assert.deepEqual(f.warnings, []);
});
test('runtime capability loss reconciles without a settings change or open popover', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.requests[0].resolve(inspection());
  await started;
  f.state.graph = graph('/A', { resources: [manifest.resources[0]] });
  assert.equal(f.state.enabled, false);
  assert.equal(f.warnings.length, 1);
});
test('rapid mode changes ignore stale capability results', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.state.mode = 'headphone';
  f.requests[0].resolve(inspection({ resources: [] }));
  await started;
  assert.equal(f.manager.support(combined).status, 'checking');
  assert.equal(f.state.enabled, true);
  f.requests[1].resolve(inspection());
  await settle();
  assert.equal(f.state.enabled, true);
});
test('inspection failure settles unavailable instead of leaving resources pending forever', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.requests[0].reject(new Error('not loadable'));
  await started;
  assert.equal(f.manager.support(combined).status, 'unsupported');
  assert.equal(f.state.enabled, false);
  assert.equal(f.warnings.length, 1);
});
test('a late failure cannot clear a newer supported file selection', async (t) => {
  const f = fixture(t);
  const started = f.manager.start();
  f.state.file = ir;
  f.requests[0].resolve(inspection({ resources: [manifest.resources[0]] }));
  await started;
  assert.equal(f.state.enabled, true);
  assert.equal(f.command().providerResources.length, 1);
  assert.equal(f.warnings.length, 0);
});

function plazaFixture(t, downloaded = []) {
  const state = vue.reactive({
    engine: provider,
    selectedImpulseResponseId: '',
    impulseResponseEnabled: false,
    impulseResponseFiles: downloaded,
  });
  const selected = [],
    warnings = [],
    actions = [];
  const player = {
    getSpatialAudioEffectSupport: (file) => support.audioEffectSupport(file, state.engine),
    selectSpatialAudioEffect: (id) => {
      const file = state.impulseResponseFiles.find((f) => f.id === id);
      if (!file || player.getSpatialAudioEffectSupport(file).status !== 'supported') return false;
      selected.push(id);
      return true;
    },
  };
  const { useAudioEffectPlaza } = loadModule('../src/renderer/composables/useAudioEffectPlaza.ts', {
    vue,
    '@/stores/setting': {
      useSettingStore: () => ({
        get impulseResponseFiles() {
          return state.impulseResponseFiles;
        },
        get selectedImpulseResponseId() {
          return state.selectedImpulseResponseId;
        },
        get impulseResponseEnabled() {
          return state.impulseResponseEnabled;
        },
        addImpulseResponseFile: (file) => state.impulseResponseFiles.push(file),
      }),
    },
    '@/stores/player': { usePlayerStore: () => player },
    '@/stores/toast': {
      useToastStore: () => ({
        warning: (reason) => warnings.push(reason),
        success() {},
        showAction: (_text, action) => actions.push(action),
      }),
    },
    '@/api/audioEffect': {
      getCommunityImpulseResponseUrls: (e) => e.impulseResponseUrls,
      getCommunityVpfUrls: (e) => e.vpfUrls,
    },
  });
  const scope = vue.effectScope();
  t.after(() => scope.stop());
  return { plaza: scope.run(useAudioEffectPlaza), state, selected, warnings, actions };
}
const online = {
  id: 1,
  name: '在线组合',
  source: 'market',
  impulseResponseUrls: ['https://a.kugou.com/a.irs'],
  vpfUrls: ['https://a.kugou.com/a.vpf'],
};
test('downloaded plaza effects use the same guard and cannot remain visually active when unsupported', async (t) => {
  const f = plazaFixture(t, [{ ...combined, id: 'community-effect-1' }]);
  f.state.engine = { kind: 'builtin' };
  f.state.selectedImpulseResponseId = 'community-effect-1';
  f.state.impulseResponseEnabled = true;
  assert.equal(f.plaza.isActive(online), false);
  assert.match(f.plaza.unavailableReason(online), /VPF/);
  await f.plaza.actOnEffect(online);
  assert.equal(f.selected.length, 0);
  f.state.engine = provider;
  f.state.impulseResponseEnabled = false;
  await f.plaza.actOnEffect(online);
  assert.deepEqual(f.selected, ['community-effect-1']);
});
test('download action rechecks capability after an engine change and retains downloaded files', async (t) => {
  const f = plazaFixture(t);
  // Only WAV is advertised; the source URL is IRS, but the real downloader
  // canonicalizes the local filename to impulse-response.wav.
  f.state.engine = {
    kind: 'provider',
    manifest: {
      resources: [{ kind: 'impulse-response', extensions: ['.wav'] }, manifest.resources[1]],
    },
  };
  const previousWindow = globalThis.window;
  globalThis.window = {
    electron: {
      audioEffects: {
        downloadCommunityAudioEffect: async () => ({
          file: { ...combined, id: 'community-effect-1' },
        }),
      },
    },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  await f.plaza.actOnEffect(online);
  assert.equal(f.actions.length, 1);
  assert.equal(f.state.impulseResponseFiles.length, 1);
  f.state.engine = { kind: 'builtin' };
  f.actions[0].handler();
  assert.equal(f.selected.length, 0);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.state.impulseResponseFiles.length, 1);
});
