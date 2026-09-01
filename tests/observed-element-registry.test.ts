import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservedElementRegistry,
  createObservedRootConnectionMonitor,
  observeRootConnectionChanges,
} from '../src/shared/observed-element-registry.ts';

test('releases cleanup as soon as an observed element becomes inactive', () => {
  const cleaned: string[] = [];
  const registry = createObservedElementRegistry<object>((cleanup) => cleanup());
  const lyricBar = {};
  const playerBar = {};

  registry.add(lyricBar, () => cleaned.push('lyric'));
  registry.add(playerBar, () => cleaned.push('player'));

  assert.equal(
    registry.prune((element) => element === playerBar),
    1,
  );
  assert.deepEqual(cleaned, ['lyric']);
  assert.equal(registry.getSize(), 1);

  registry.clear();
  assert.deepEqual(cleaned, ['lyric', 'player']);
  assert.equal(registry.getSize(), 0);
});

test('allows the same route element to be observed again after removal', () => {
  let cleanupCount = 0;
  const registry = createObservedElementRegistry<object>((cleanup) => cleanup());
  const lyricBar = {};

  assert.equal(
    registry.add(lyricBar, () => cleanupCount++),
    true,
  );
  assert.equal(
    registry.add(lyricBar, () => cleanupCount++),
    false,
  );
  assert.equal(registry.release(lyricBar), true);
  assert.equal(cleanupCount, 1);

  assert.equal(
    registry.add(lyricBar, () => cleanupCount++),
    true,
  );
  registry.clear();
  assert.equal(cleanupCount, 2);
});

test('tracks and prunes observed elements without cleanup callbacks', () => {
  const registry = createObservedElementRegistry<object>((cleanup) => cleanup());
  const element = {};

  registry.add(element);
  assert.equal(registry.getSize(), 1);
  assert.equal(
    registry.prune(() => false),
    1,
  );
  assert.equal(registry.getSize(), 0);
});

test('clears active observers in reverse mount order', () => {
  const cleaned: string[] = [];
  const registry = createObservedElementRegistry<object>((cleanup) => cleanup());

  registry.add({}, () => cleaned.push('first'));
  registry.add({}, () => cleaned.push('second'));
  registry.clear();

  assert.deepEqual(cleaned, ['second', 'first']);
});

test('cleans custom-root elements when the root is removed and rescans after reinsertion', () => {
  let rootConnected = true;
  let scanCount = 0;
  let cleanupCount = 0;
  const registry = createObservedElementRegistry<object>((cleanup) => cleanup());
  const item = {};
  const scan = () => {
    scanCount += 1;
    registry.add(item, () => cleanupCount++);
  };
  const monitor = createObservedRootConnectionMonitor(
    () => rootConnected,
    () => registry.clear(),
    scan,
  );
  const ownerDocument = {};
  let notifyDocumentMutation = () => {};
  let observedTarget: object | null = null;
  let disconnected = false;
  const stopObservingRoot = observeRootConnectionChanges(
    ownerDocument,
    (callback) => {
      notifyDocumentMutation = callback;
      return {
        observe: (target) => {
          observedTarget = target;
        },
        disconnect: () => {
          disconnected = true;
        },
      };
    },
    monitor,
  );

  scan();
  assert.equal(registry.getSize(), 1);
  assert.equal(observedTarget, ownerDocument);

  rootConnected = false;
  notifyDocumentMutation();
  assert.equal(monitor.isConnected(), false);
  assert.equal(cleanupCount, 1);
  assert.equal(registry.getSize(), 0);
  notifyDocumentMutation();
  assert.equal(cleanupCount, 1);

  rootConnected = true;
  notifyDocumentMutation();
  assert.equal(monitor.isConnected(), true);
  assert.equal(scanCount, 2);
  assert.equal(registry.getSize(), 1);

  stopObservingRoot();
  assert.equal(disconnected, true);
  registry.clear();
  assert.equal(cleanupCount, 2);
});
