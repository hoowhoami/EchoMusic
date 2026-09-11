import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EchoPluginDescriptor } from '../src/shared/plugins.ts';
import { createPluginMetadataRegistry } from '../src/main/plugins/metadata.ts';

const descriptor = (version = '1', tcp = true): EchoPluginDescriptor =>
  ({
    id: 'rgb',
    version,
    enabled: true,
    invalid: false,
    directory: '/plugins/rgb',
    manifest: { id: 'rgb', name: 'RGB', version, capabilities: { tcp } },
    compatibility: { compatible: true },
  }) as EchoPluginDescriptor;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('metadata lookups and missing IDs never scan; explicit refresh is shared', async () => {
  let scans = 0;
  const pending = deferred<EchoPluginDescriptor[]>();
  const registry = createPluginMetadataRegistry(
    () => {
      scans++;
      return pending.promise;
    },
    () => {},
  );
  assert.equal(registry.getSafeMode(), true);
  assert.equal(registry.get('rgb'), null);
  registry.setEnabled({ rgb: true });
  registry.setSafeMode(false);
  const first = registry.refresh();
  assert.equal(registry.refresh(), first);
  pending.resolve([descriptor()]);
  await first;
  for (let i = 0; i < 1000; i++) {
    assert(registry.get('rgb')?.enabled);
    assert.equal(registry.get('unknown'), null);
    registry.list();
    registry.getSafeMode();
  }
  assert.equal(scans, 1);
});

test('disable and safe-mode revoke immediately, including across re-enable', async () => {
  const revoked: string[][] = [];
  const registry = createPluginMetadataRegistry(
    async () => [descriptor()],
    (ids) => revoked.push(ids),
  );
  registry.setEnabled({ rgb: true });
  registry.setSafeMode(false);
  await registry.refresh();
  const original = registry.get('rgb')!;
  registry.setEnabled({ rgb: false });
  assert.equal(registry.get('rgb')?.enabled, false);
  assert.equal(registry.isCurrent(original), false);
  registry.setEnabled({ rgb: true });
  assert.equal(registry.isCurrent(original), false);
  const enabled = registry.get('rgb')!;
  registry.setSafeMode(true);
  registry.setSafeMode(false);
  assert.equal(registry.isCurrent(enabled), false);
  assert.deepEqual(revoked, [['rgb'], ['rgb']]);
});

test('late scans cannot resurrect an uninstalled plugin', async () => {
  const pending = deferred<EchoPluginDescriptor[]>();
  let scans = 0;
  const registry = createPluginMetadataRegistry(
    () => (++scans === 1 ? pending.promise : Promise.resolve([])),
    () => {},
  );
  const refresh = registry.refresh();
  const finish = registry.beginMutation('rgb');
  finish();
  pending.resolve([descriptor()]);
  await refresh;
  assert.equal(scans, 2);
  assert.equal(registry.get('rgb'), null);
});

test('mutation hides partial installs, rejects competing mutations and publishes new capabilities', async () => {
  let disk = descriptor();
  const registry = createPluginMetadataRegistry(
    async () => [disk],
    () => {},
  );
  registry.setEnabled({ rgb: true });
  registry.setSafeMode(false);
  await registry.refresh();
  const old = registry.get('rgb')!;
  const finish = registry.beginMutation('rgb');
  assert.equal(registry.get('rgb'), null);
  assert.throws(() => registry.beginMutation('rgb'), /更新/);
  disk = descriptor('2', false);
  await registry.refresh();
  assert.equal(registry.get('rgb'), null);
  finish();
  await registry.refresh();
  assert.equal(registry.get('rgb')?.manifest.capabilities?.tcp, false);
  assert.equal(registry.isCurrent(old), false);
  // Rollback is another filesystem mutation, not reinstatement of the old cached object.
  const rollback = registry.beginMutation('rgb');
  disk = descriptor();
  rollback();
  await registry.refresh();
  assert.equal(registry.get('rgb')?.version, '1');
  assert.equal(registry.isCurrent(old), false);
});

test('an in-flight refresh uses current enabled preferences and unchanged metadata preserves handles', async () => {
  let disk = descriptor();
  let load = async () => [disk];
  const revoked: string[][] = [];
  const registry = createPluginMetadataRegistry(
    () => load(),
    (ids) => revoked.push(ids),
  );
  registry.setEnabled({ rgb: true });
  registry.setSafeMode(false);
  await registry.refresh();
  const original = registry.get('rgb');
  await registry.refresh();
  assert.equal(registry.get('rgb'), original);
  assert.deepEqual(revoked, []);
  const pending = deferred<EchoPluginDescriptor[]>();
  load = () => pending.promise;
  const refresh = registry.refresh();
  registry.setEnabled({ rgb: false });
  pending.resolve([disk]);
  await refresh;
  assert.equal(registry.get('rgb')?.enabled, false);
  disk = descriptor('2', false);
  load = async () => [disk];
  await registry.refresh();
  assert.equal(registry.get('rgb')?.manifest.capabilities?.tcp, false);
});

test('scan failure revokes old records, retries recover, and duplicate IDs fail closed', async () => {
  let load = async () => [descriptor()];
  const revoked: string[][] = [];
  const registry = createPluginMetadataRegistry(
    () => load(),
    (ids) => revoked.push(ids),
  );
  await registry.refresh();
  load = async () => {
    throw new Error('unreadable root');
  };
  await assert.rejects(registry.refresh(), /unreadable/);
  assert.equal(registry.get('rgb'), null);
  assert.deepEqual(revoked, [['rgb']]);
  load = async () => [descriptor()];
  await registry.refresh();
  assert(registry.get('rgb'));
  load = async () => [descriptor(), { ...descriptor(), directory: '/plugins/duplicate' }];
  await registry.refresh();
  assert.equal(registry.get('rgb'), null);
});
