import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { installWindowBackgroundThrottling } from '../src/main/windowBackgroundThrottling.ts';

test('closed windows release policy listeners and ignore late visibility events', () => {
  const changes = [];
  let destroyed = false;
  const win = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    isVisible: () => true,
    webContents: {
      isDestroyed: () => destroyed,
      setBackgroundThrottling: (value) => changes.push(value),
    },
  });
  installWindowBackgroundThrottling(win);
  assert.deepEqual(changes, [], 'installation must preserve the initial paint policy');
  win.emit('show');
  assert.deepEqual(changes, [false]);
  destroyed = true;
  win.emit('hide');
  assert.deepEqual(changes, [false], 'destroyed contents must not be accessed');
  win.emit('closed');
  for (const event of ['show', 'hide', 'minimize', 'restore']) {
    assert.equal(win.listenerCount(event), 0);
    win.emit(event);
  }
  assert.deepEqual(changes, [false]);
});
