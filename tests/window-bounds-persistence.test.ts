import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindWindowBoundsPersistenceEvents,
  shouldFlushWindowBounds,
  WindowBoundsPersistenceGate,
} from '../src/main/windowBoundsPersistence.ts';

const createEventTarget = () => {
  const listeners = new Map<string, Array<() => void>>();
  return {
    target: {
      on(event: string, listener: () => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
};

test('Windows ignores programmatic move and resize events', () => {
  const gate = new WindowBoundsPersistenceGate('win32');

  assert.equal(gate.shouldPersist('move'), false);
  assert.equal(gate.shouldPersist('resize'), false);
});

test('Windows persists one matching event after a manual change starts', () => {
  const gate = new WindowBoundsPersistenceGate('win32');

  gate.markManualChange('resize');
  assert.equal(gate.shouldPersist('resize'), true);
  assert.equal(gate.shouldPersist('resize'), false);
});

test('Windows tracks move and resize independently', () => {
  const gate = new WindowBoundsPersistenceGate('win32');

  gate.markManualChange('move');
  assert.equal(gate.shouldPersist('resize'), false);
  assert.equal(gate.shouldPersist('move'), true);
});

test('other platforms persist ordinary bounds events', () => {
  const gate = new WindowBoundsPersistenceGate('darwin');

  assert.equal(gate.shouldPersist('move'), true);
  assert.equal(gate.shouldPersist('resize'), true);
});

test('Windows event binding ignores creation resize but persists manual resize', () => {
  const events = createEventTarget();
  let persisted = 0;
  bindWindowBoundsPersistenceEvents(
    events.target,
    () => {
      persisted += 1;
    },
    'win32',
  );

  events.emit('resized');
  assert.equal(persisted, 0);

  events.emit('will-resize');
  events.emit('resized');
  assert.equal(persisted, 1);
});

test('non-Windows event binding uses move and resize events directly', () => {
  const events = createEventTarget();
  let persisted = 0;
  bindWindowBoundsPersistenceEvents(
    events.target,
    () => {
      persisted += 1;
    },
    'linux',
  );

  events.emit('move');
  events.emit('resize');
  assert.equal(persisted, 2);
});

test('Windows close flushes only user-modified bounds', () => {
  assert.equal(shouldFlushWindowBounds(false, 'win32'), false);
  assert.equal(shouldFlushWindowBounds(true, 'win32'), true);
});

test('other platforms retain close-time bounds persistence', () => {
  assert.equal(shouldFlushWindowBounds(false, 'darwin'), true);
  assert.equal(shouldFlushWindowBounds(false, 'linux'), true);
});
