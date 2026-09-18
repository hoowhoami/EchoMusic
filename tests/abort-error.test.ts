import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbortError } from '../src/shared/abortError.ts';
import { stringifyForLog } from '../src/shared/logging.ts';

test('recognizes Chromium fetch abort', () => {
  const error = new DOMException('The user aborted a request.', 'AbortError');
  assert.equal(isAbortError(error), true);
});

test('recognizes DOM and Axios abort shapes', () => {
  assert.equal(isAbortError(new DOMException('The operation was aborted', 'AbortError')), true);
  assert.equal(isAbortError(new DOMException('This operation was aborted', 'AbortError')), true);
  assert.equal(isAbortError({ name: 'CanceledError', message: 'canceled', code: 'ERR_CANCELED' }), true);
  assert.equal(isAbortError({ __CANCEL__: true, message: 'canceled' }), true);
  assert.equal(isAbortError('The user aborted a request.'), true);
});

test('does not treat real failures as aborts', () => {
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError({}), false);
  assert.equal(isAbortError(new Error('network connection timed out')), false);
  assert.equal(isAbortError(new DOMException('The operation timed out.', 'TimeoutError')), false);
  assert.equal(isAbortError('request was not canceled by the user'), false);
});

test('serializes Error objects for logs instead of empty objects', () => {
  const error = new DOMException('The user aborted a request.', 'AbortError');
  const text = stringifyForLog(error);
  assert.match(text, /AbortError/);
  assert.match(text, /The user aborted a request/);
});
