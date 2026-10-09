import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { build } from 'esbuild';
const output = await build({
  entryPoints: ['src/renderer/theme/prepareThemeImage.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
});
const module = { exports: {} };
new Function('module', 'exports', output.outputFiles[0].text)(module, module.exports);
const { prepareThemeImage } = module.exports;
const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const file = (data = signature, type = '') => new File([data], 'image', { type });
let size, closed, draws, canvas, failDecode, failEncode;
beforeEach(() => {
  size = { width: 9494, height: 6329 };
  closed = 0;
  draws = [];
  failDecode = false;
  failEncode = false;
  globalThis.createImageBitmap = async () => {
    if (failDecode) throw new Error('decoder failure');
    return { ...size, close: () => closed++ };
  };
  globalThis.document = {
    createElement: () =>
      (canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: (...args) => draws.push(args) }),
        toBlob: (callback, type) => {
          assert.equal(type, 'image/png');
          callback(failEncode ? null : new Blob([signature]));
        },
      }),
  };
});
test('the reported 9494 by 6329 JPEG fits 2560 by 1707 instead of hitting the former pixel cap', async () => {
  assert.deepEqual(
    await prepareThemeImage(file(Uint8Array.from([255, 216, 255]), 'image/jpeg')),
    signature,
  );
  assert.deepEqual(draws[0].slice(1), [0, 0, 2560, 1707]);
  assert.equal(closed, 1);
  assert.equal(canvas.width, 0);
});
test('portrait and small images preserve proportions and are never enlarged', async () => {
  for (const [width, height, expected] of [
    [6329, 9494, [1707, 2560]],
    [640, 360, [640, 360]],
    [1, 20000, [1, 2560]],
  ]) {
    size = { width, height };
    await prepareThemeImage(file());
    assert.deepEqual(draws.at(-1).slice(3), expected);
  }
});
test('signature validation accepts WebP and empty MIME types and rejects renamed non-images', async () => {
  await prepareThemeImage(file(new TextEncoder().encode('RIFF0000WEBP')));
  await prepareThemeImage(file());
  await assert.rejects(
    prepareThemeImage(file(new TextEncoder().encode('not an image'), 'image/png')),
    /仅支持/,
  );
});
test('file size, decode and pixel-limit failures have distinct messages', async () => {
  await assert.rejects(prepareThemeImage(file(new Uint8Array(20 * 1024 * 1024 + 1))), /20 MB/);
  failDecode = true;
  await assert.rejects(prepareThemeImage(file()), /无法解码.*损坏/);
  failDecode = false;
  size = { width: 20000, height: 10000 };
  await assert.rejects(prepareThemeImage(file()), /20000 × 10000.*1 亿像素/);
  assert.equal(closed, 1);
});
test('encoding failure releases bitmap and canvas resources', async () => {
  failEncode = true;
  await assert.rejects(prepareThemeImage(file()), /图片处理失败/);
  assert.equal(closed, 1);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
});
