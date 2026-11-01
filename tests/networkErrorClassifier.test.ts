import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachFetchErrorContext,
  classifyNetworkError,
} from '../src/shared/networkErrorClassifier.ts';

test('Chromium 网络栈错误按类别映射为友好文案', () => {
  const detail = classifyNetworkError(new Error('net::ERR_CONNECTION_RESET'), {
    url: 'https://raw.githubusercontent.com/a/b/main/echo-plugins.json',
  });
  assert.equal(detail.category, 'reset');
  assert.equal(detail.categoryLabel, '连接被重置');
  assert.equal(detail.url, 'https://raw.githubusercontent.com/a/b/main/echo-plugins.json');
  assert.ok(detail.title.length > 0);
  assert.ok(detail.hint.length > 0);
});

test('cause 链上的错误码也能识别（Node 风格 ENOTFOUND）', () => {
  const cause = new Error('getaddrinfo ENOTFOUND github.com');
  const error = new Error('request failed', { cause });
  const detail = classifyNetworkError(error);
  assert.equal(detail.category, 'dns');
});

test('HTTP 状态码分类：403/429 限流、404 索引不存在', () => {
  const limited = classifyNetworkError(attachFetchErrorContext(new Error('请求失败 (403)'), { statusCode: 403 }));
  assert.equal(limited.category, 'rate-limit');
  const missing = classifyNetworkError(attachFetchErrorContext(new Error('请求失败 (404)'), { statusCode: 404 }));
  assert.equal(missing.category, 'not-found');
  assert.equal(missing.httpStatus, 404);
});

test('超时消息（含既有中文文案）归类为连接超时', () => {
  const detail = classifyNetworkError(
    new Error('插件源请求超时，请检查网络或 GitHub 加速地址'),
  );
  assert.equal(detail.category, 'timeout');
});

test('代理与断网类别', () => {
  assert.equal(
    classifyNetworkError(new Error('net::ERR_TUNNEL_CONNECTION_FAILED')).category,
    'proxy',
  );
  assert.equal(
    classifyNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')).category,
    'offline',
  );
});

test('未知错误兜底并保留原始消息', () => {
  const detail = classifyNetworkError(new Error('奇怪的异常'));
  assert.equal(detail.category, 'unknown');
  assert.equal(detail.rawMessage, '奇怪的异常');
  assert.equal(detail.categoryLabel, '加载失败');
});
