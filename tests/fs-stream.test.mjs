import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/main/fsStream.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { fsReadStreamToWeb } = module.exports;

test('桥接流按顺序透传全部字节', async () => {
  const source = Readable.from([Buffer.from('ab'), Buffer.from('cd')]);
  const reader = fsReadStreamToWeb(source, new AbortController().signal).getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');
  assert.equal(source.destroyed, true);
});

test('revoke 后迟到的 data 不会对已结算控制器 enqueue', async () => {
  const source = new Readable({ read() {} });
  const controller = new AbortController();
  const reader = fsReadStreamToWeb(source, controller.signal).getReader();
  source.push(Buffer.from('first'));
  assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
  controller.abort(new Error('revoked'));
  await assert.rejects(reader.read(), /revoked/);
  // 复现 Node 22 适配器的竞态窗口：控制器结算之后源流仍有排队数据到达，
  // 实现必须以 settled 标志忽略，而不是对已关闭控制器 enqueue。
  source.push(Buffer.from('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.destroyed, true);
});

test('已中止的信号立即以原因结算并销毁源流', async () => {
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  const source = new Readable({ read() {} });
  await assert.rejects(
    fsReadStreamToWeb(source, controller.signal).getReader().read(),
    /pre-aborted/,
  );
  assert.equal(source.destroyed, true);
});
