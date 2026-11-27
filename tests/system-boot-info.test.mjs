import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

// 编译 src/main/ipc/system.ts，把 node:os 与 ipcRegistry 换成桩，不真读系统状态。
const source = readFileSync(new URL('../src/main/ipc/system.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;

function setup(uptimeSec, now) {
  const mod = { exports: {} };
  let handler;
  const os = { uptime: () => uptimeSec, default: { uptime: () => uptimeSec } };
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  new Function('require', 'module', 'exports', 'Date', code)(
    (name) => {
      if (name === 'node:os') return os;
      if (name === './registry') {
        return {
          ipcRegistry: {
            registerHandler: (channel, callback) => {
              handler = { channel, callback };
            },
          },
        };
      }
      throw new Error('unexpected dependency: ' + name);
    },
    mod,
    mod.exports,
    FakeDate,
  );
  // handler 在 register() 里才赋值，用 getter 暴露，避免返回时被快照成 undefined
  return {
    register: mod.exports.registerSystemHandlers,
    get handler() {
      return handler;
    },
  };
}

test('注册 system:get-boot-info，供插件读开机时长', () => {
  const s = setup(120, 1_000_000);
  s.register();
  assert.equal(s.handler.channel, 'system:get-boot-info');
});

test('返回整数秒的运行时长，并据此反推开机时刻', () => {
  const s = setup(1234.7, 1_700_000_000_000);
  s.register();
  assert.deepEqual(s.handler.callback(), {
    uptimeSec: 1234,
    bootTimeMs: 1_700_000_000_000 - 1234 * 1000,
  });
});

test('刚开机时运行时长归零，开机时刻等于当前时间', () => {
  const s = setup(0.4, 5_000);
  s.register();
  assert.deepEqual(s.handler.callback(), { uptimeSec: 0, bootTimeMs: 5_000 });
});

test('只暴露时长与开机时刻，不带任何机器标识', () => {
  const s = setup(10, 20_000);
  s.register();
  assert.deepEqual(Object.keys(s.handler.callback()).sort(), ['bootTimeMs', 'uptimeSec']);
});
