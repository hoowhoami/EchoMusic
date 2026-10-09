import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
const result = await build({
  entryPoints: ['src/renderer/utils/color.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const module = { exports: {} };
new Function('module', 'exports', result.outputFiles[0].text)(module, module.exports);
const { extractAverageColor } = module.exports;
let pixels, latestImage, canvas, drawArgs;
globalThis.window = { setTimeout, clearTimeout };
globalThis.Image = class {
  constructor() {
    latestImage = this;
    this.naturalWidth = 200;
    this.naturalHeight = 100;
  }
  set src(value) {
    if (value && value !== 'pending') queueMicrotask(() => this.onload?.());
  }
};
globalThis.document = {
  createElement: () =>
    (canvas = {
      width: 64,
      height: 64,
      getContext: () => ({
        drawImage(...args) {
          drawArgs = args;
        },
        getImageData: () => ({ data: pixels }),
      }),
    }),
};
test('average color includes neutral pixels and weights alpha without transparent-color contamination', async () => {
  pixels = Uint8ClampedArray.from([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]);
  assert.equal(await extractAverageColor('sample'), '#808080');
  assert.equal(canvas.width, 0);
  assert.equal(latestImage.onload, null);
  pixels = Uint8ClampedArray.from([255, 0, 0, 255, 0, 0, 255, 85]);
  assert.equal(await extractAverageColor('sample'), '#bf0040');
  pixels = Uint8ClampedArray.from([255, 0, 0, 0]);
  assert.equal(await extractAverageColor('sample'), null);
});
test('cancelled image sampling releases callbacks and resolves without stale color', async () => {
  const controller = new AbortController();
  const sample = extractAverageColor('pending', { signal: controller.signal });
  controller.abort();
  assert.equal(await sample, null);
  assert.equal(latestImage.onload, null);
  assert.equal(latestImage.onerror, null);
  assert.equal(await extractAverageColor('sample', { signal: controller.signal }), null);
});

test('artwork sampling reads the selected crop in natural image coordinates', async () => {
  pixels = Uint8ClampedArray.from([16, 16, 16, 255]);
  assert.equal(
    await extractAverageColor('sample', {
      crop: { x: 10, y: 5, width: 50, height: 20, sourceWidth: 100, sourceHeight: 50 },
    }),
    '#101010',
  );
  assert.deepEqual(drawArgs.slice(1), [20, 10, 100, 40, 0, 0, 64, 64]);
});
