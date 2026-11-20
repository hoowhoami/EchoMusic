import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
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
  // 直接派发 data 事件，模拟已排队的 chunk 在控制器结算后到达：
  // 缺少 settled 守卫时这里会对 errored 控制器 enqueue 并抛 ERR_INVALID_STATE。
  assert.doesNotThrow(() => source.emit('data', Buffer.from('late')));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.destroyed, true);
});

test('pre-aborted 信号下源流 open 失败不会产生未捕获异常', async () => {
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  const missing = fileURLToPath(new URL(`./.missing-${Date.now()}.bin`, import.meta.url));
  const source = createReadStream(missing);
  await assert.rejects(
    fsReadStreamToWeb(source, controller.signal).getReader().read(),
    /pre-aborted/,
  );
  // 等 open 失败的错误事件落地：若 error 监听缺失，测试进程会因未捕获异常直接失败。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(source.destroyed, true);
});

test('源流被提前销毁时以错误结算而不是永久挂起', async () => {
  const source = new Readable({ read() {} });
  const reader = fsReadStreamToWeb(source, new AbortController().signal).getReader();
  const pending = reader.read();
  source.destroy();
  await assert.rejects(pending, /读取流意外关闭/);
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
