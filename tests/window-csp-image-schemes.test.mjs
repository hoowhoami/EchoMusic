import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 入口页面的 CSP 必须放行内嵌封面协议。
 *
 * 内嵌封面不走网络，而是以 `echo-player-cover://artwork/<hash>` 交给渲染层
 * （见 src/main/player/embeddedMetadata.ts 注册的协议）。带 CSP 的入口若没把该
 * scheme 写进 img-src，`<img>` 请求会被直接拦掉——不报错、无日志，只是封面
 * 空白，排查成本极高（曾因此误以为是快照没带到）。
 *
 * 没有 CSP 的入口（index.html / desktop-lyric.html）不受此限。
 */

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ENTRY_HTML = readdirSync(ROOT).filter((name) => name.endsWith('.html'));

/** 从 CSP 中取出某个指令的来源列表，空数组表示该指令未声明。 */
const directiveSources = (policy, directive) => {
  const match = policy.match(new RegExp(`${directive}\\s+([^;]+)`));
  return match ? match[1].trim().split(/\s+/).filter(Boolean) : [];
};

const entries = ENTRY_HTML.map((name) => {
  const source = readFileSync(join(ROOT, name), 'utf8');
  const policy = source.match(/Content-Security-Policy"\s*content="([^"]+)"/)?.[1] ?? null;
  return { name, policy };
});

test('入口 HTML 至少有被检查的那几个，避免读取目录的方式失效导致空跑', () => {
  assert.ok(
    entries.some((entry) => entry.name === 'taskbar-player.html'),
    '未找到 taskbar-player.html，测试可能已失效',
  );
});

test('带 CSP 的入口必须在 img-src 放行内嵌封面协议', () => {
  for (const { name, policy } of entries) {
    if (!policy) continue;
    assert.ok(
      directiveSources(policy, 'img-src').includes('echo-player-cover:'),
      `${name} 的 CSP 未放行 echo-player-cover:，内嵌封面会被静默拦截：${policy}`,
    );
  }
});

test('CSP 解析本身可用（防止上面的断言因解析错误而空过）', () => {
  const entry = entries.find((item) => item.policy);
  assert.ok(entry, '预期至少一个入口声明了 CSP');
  assert.ok(
    directiveSources(entry.policy, 'img-src').length > 0,
    '未能从 CSP 中解析出 img-src',
  );
});