import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const module = { exports: {} };
new Function('module', transformSync(readFileSync(new URL('../src/main/consolePipeGuard.ts', import.meta.url), 'utf8'), {loader: 'ts', format: 'cjs'}).code)(module);
const { createConsolePipeGuard } = module.exports;
const brokenPipe = () => Object.assign(new Error('broken pipe'), {code: 'EPIPE'});

test('synchronous EPIPE disables console once and prevents subsequent writes', () => {
  let disabled = 0;
  let writes = 0;
  const guard = createConsolePipeGuard(() => disabled++);
  guard.write(() => writes++);
  guard.write(() => { writes++; throw brokenPipe(); });
  guard.write(() => writes++);
  assert.equal(writes, 2);
  assert.equal(disabled, 1);
  assert.equal(guard.disconnected, true);
});

test('asynchronous stdout and stderr EPIPE are handled without recursive logging', () => {
  let disabled = 0;
  const guard = createConsolePipeGuard(() => disabled++);
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  guard.watch(stdout);
  guard.watch(stderr);
  stdout.emit('error', brokenPipe());
  stderr.emit('error', brokenPipe());
  assert.equal(disabled, 1);
  assert.equal(guard.disconnected, true);
});

test('unrelated exceptions are not swallowed', () => {
  const guard = createConsolePipeGuard(() => assert.fail());
  const error = new Error('formatting bug');
  assert.throws(() => guard.write(() => { throw error; }), error);
  const stream = new EventEmitter();
  guard.watch(stream);
  assert.throws(() => stream.emit('error', error), error);
  assert.equal(guard.disconnected, false);
});
