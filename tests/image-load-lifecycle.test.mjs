import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import { compileScript, parse } from 'vue/compiler-sfc';

const guardModule = { exports: {} };
new Function(
  'module',
  'exports',
  transformSync(readFileSync('src/renderer/utils/imageLoadEvent.ts', 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code,
)(guardModule, guardModule.exports);

function fixture(t, name, initial = 'a.png') {
  const fallback = vue.ref('fallback.png');
  const { descriptor } = parse(readFileSync(`src/renderer/components/ui/${name}.vue`, 'utf8'));
  const script = compileScript(descriptor, { id: name });
  const { code } = transformSync(script.content, { loader: 'ts', format: 'cjs' });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id === 'vue') return vue;
      if (id === '@/utils/imageLoadEvent') return guardModule.exports;
      if (id === '@/utils/cover')
        return {
          normalizeCoverUrl: (url) => url || '',
          resolveCoverDisplayUrl: () => fallback.value,
        };
      if (id === './Skeleton.vue') return { default: {} };
      if (id === '@/icons') return {};
      throw new Error(`Unexpected dependency ${id}`);
    },
    mod,
    mod.exports,
  );
  const sourceProp = name === 'Cover' ? 'url' : 'src';
  const props = vue.reactive({ [sourceProp]: initial, size: 400, alt: 'test' });
  const scope = vue.effectScope();
  const api = scope.run(() => mod.exports.default.setup(props, { expose() {} }));
  t.after(() => scope.stop());
  const source = () => (name === 'Cover' ? api.processedUrl.value : props.src);
  const attach = () => {
    const src = source();
    const image = vue.markRaw({ getAttribute: (name) => (name === 'src' ? src : null) });
    api.imageRef.value = image;
    return { currentTarget: image };
  };
  return {
    api,
    props,
    fallback,
    source,
    attach,
    setSource: (value) => {
      props[sourceProp] = value;
    },
    status: () => api.status.value,
  };
}

for (const name of ['Image', 'Cover']) {
  test(`${name}: old events before and after DOM replacement cannot settle the new source`, async (t) => {
    const f = fixture(t, name),
      old = f.attach();
    f.setSource('b.png');
    f.api.handleError(old); // props changed, DOM not patched yet
    await vue.nextTick();
    assert.equal(f.source(), 'b.png');
    assert.equal(f.status(), 'loading');
    const current = f.attach();
    f.api.handleLoad(old);
    f.api.handleError(old);
    assert.equal(f.status(), 'loading');
    f.api.handleLoad(current);
    assert.equal(f.status(), 'success');
    f.api.handleError(old);
    assert.equal(f.status(), 'success');
  });

  test(`${name}: returning to the same URL rejects events from the first DOM node`, async (t) => {
    const f = fixture(t, name),
      first = f.attach();
    f.setSource('b.png');
    await vue.nextTick();
    f.attach();
    f.setSource('a.png');
    await vue.nextTick();
    const current = f.attach();
    f.api.handleLoad(first);
    f.api.handleError(first);
    assert.equal(f.status(), 'loading');
    f.api.handleLoad(current);
    assert.equal(f.status(), 'success');
  });

  test(`${name}: detached image events have no effect`, (t) => {
    const f = fixture(t, name),
      event = f.attach();
    f.api.imageRef.value = null;
    f.api.handleLoad(event);
    f.api.handleError(event);
    assert.equal(f.status(), 'loading');
  });
}

test('Image: clearing the source stays in error placeholder despite old load events', async (t) => {
  const f = fixture(t, 'Image'),
    old = f.attach();
  f.setSource('');
  await vue.nextTick();
  f.api.handleLoad(old);
  assert.equal(f.status(), 'error');
  f.setSource('retry.png');
  await vue.nextTick();
  f.api.handleError(f.attach());
  assert.equal(f.status(), 'error');
});

test('Cover: primary failure loads fallback once, ignoring repeated primary errors', async (t) => {
  const f = fixture(t, 'Cover'),
    primary = f.attach();
  f.api.handleError(primary);
  await vue.nextTick();
  assert.equal(f.source(), 'fallback.png');
  assert.equal(f.status(), 'loading');
  f.api.handleError(primary);
  assert.equal(f.status(), 'loading');
  const fallback = f.attach();
  f.api.handleLoad(fallback);
  assert.equal(f.status(), 'success');
  f.api.handleError(primary);
  assert.equal(f.status(), 'success');
  f.api.handleError(fallback);
  assert.equal(f.status(), 'error');
});

test('Cover: fallback identical to failed primary stops loading rather than hanging forever', async (t) => {
  const f = fixture(t, 'Cover');
  f.fallback.value = 'a.png';
  f.api.handleError(f.attach());
  await vue.nextTick();
  assert.equal(f.source(), 'a.png');
  assert.equal(f.status(), 'error');
});

test('Cover: switching tracks synchronously releases the old fallback before its error', async (t) => {
  const f = fixture(t, 'Cover');
  f.api.handleError(f.attach());
  await vue.nextTick();
  const oldFallback = f.attach();
  f.setSource('next-track.png');
  f.api.handleError(oldFallback);
  await vue.nextTick();
  assert.equal(f.source(), 'next-track.png');
  assert.equal(f.api.useFallback.value, false);
  assert.equal(f.status(), 'loading');
  f.api.handleLoad(f.attach());
  assert.equal(f.status(), 'success');
});

test('Cover: a theme/plugin fallback URL change accepts only the new fallback', async (t) => {
  const f = fixture(t, 'Cover', '');
  const old = f.attach();
  f.api.handleLoad(old);
  f.fallback.value = 'theme-cover.png';
  await vue.nextTick();
  const current = f.attach();
  f.api.handleError(old);
  assert.equal(f.status(), 'loading');
  f.api.handleLoad(current);
  assert.equal(f.status(), 'success');
});
