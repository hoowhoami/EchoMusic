import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getInstalledPluginSourceName, getPluginSourceName } from '../src/shared/plugin-source.ts';

test('来源使用名称，缺少名称时回退到源地址', () => {
  assert.equal(getPluginSourceName(' 官方源 ', 'https://example.com'), '官方源');
  assert.equal(getPluginSourceName(' ', 'https://example.com'), 'https://example.com');
  assert.equal(getPluginSourceName('', ''), '未知来源');
});

test('已安装插件使用保存的来源，无需在线目录或已启用的源', () => {
  assert.equal(
    getInstalledPluginSourceName({
      kind: 'marketplace',
      id: 'removed-source',
      name: '自建源',
      url: 'https://example.com',
    }),
    '自建源',
  );
});

test('本地安装和缺少历史记录明确区分', () => {
  assert.equal(getInstalledPluginSourceName({ kind: 'local' }), '本地安装');
  assert.equal(getInstalledPluginSourceName(), '未记录来源');
});

test('历史标签仅匹配唯一目录项，本地安装不误用在线同名标签', async () => {
  const { findInstalledPluginCatalogTags } = await import('../src/shared/plugin-source.ts');
  const descriptor = { id: 'demo', name: 'Demo', version: '1.0.0', author: 'author' };
  const entry = {
    ...descriptor,
    sourceId: 'one',
    sourceUrl: 'https://example.com',
    tags: ['工具', '音乐'],
  };
  assert.deepEqual(findInstalledPluginCatalogTags(descriptor, [entry]), ['工具', '音乐']);
  assert.deepEqual(
    findInstalledPluginCatalogTags(descriptor, [entry, { ...entry, sourceId: 'two' }]),
    [],
  );
  assert.deepEqual(
    findInstalledPluginCatalogTags({ ...descriptor, installSource: { kind: 'local' } }, [entry]),
    [],
  );
  assert.deepEqual(
    findInstalledPluginCatalogTags(
      {
        ...descriptor,
        installSource: { kind: 'marketplace', id: 'one', name: '源', url: entry.sourceUrl },
      },
      [entry, { ...entry, sourceId: 'two' }],
    ),
    ['工具', '音乐'],
  );
});
