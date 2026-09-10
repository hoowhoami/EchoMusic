import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeUpdateNotes,
  extractVersionNotes,
  resolveUpdateNotes,
} from '../src/shared/update-notes.ts';

test('selects notes for the target version instead of the first array item', () => {
  assert.equal(
    normalizeUpdateNotes(
      [
        { version: '2.0.0', note: 'older' },
        { version: 'v3.0.0-beta.1', note: 'new' },
      ],
      '3.0.0-beta.1',
    ),
    'new',
  );
  assert.equal(normalizeUpdateNotes([{ version: '2.0.0', note: 'older' }], '3.0.0'), '');
  assert.equal(normalizeUpdateNotes('详见 CHANGELOG.md', '3.0.0'), '');
});

test('a generic update feed without notes fetches the exact release', async () => {
  const urls: string[] = [];
  const result = await resolveUpdateNotes(
    '3.0.0-beta.1',
    async (url) => {
      urls.push(url);
      return { body: '### 新增\n- new feature' };
    },
    async () => {
      throw new Error('must not fetch');
    },
  );
  assert.equal(result, '### 新增\n- new feature');
  assert.deepEqual(urls, [
    'https://api.github.com/repos/hoowhoami/EchoMusic/releases/tags/v3.0.0-beta.1',
  ]);
});

test('API failure falls back to the tagged changelog and excludes other releases', async () => {
  const markdown = '> header\n\n## [3.0.0] - date\n### 修复\n- fixed\n\n## [2.0.0]\n- old';
  const result = await resolveUpdateNotes(
    '3.0.0',
    async () => {
      throw new Error('offline');
    },
    async (url) => {
      assert.ok(url.includes('/v3.0.0/'));
      return markdown;
    },
  );
  assert.equal(result, '## [3.0.0] - date\n### 修复\n- fixed');
  assert.equal(extractVersionNotes(markdown, '4.0.0'), '');
});

test('manual releases use their body, or their exact tag for placeholder notes', async () => {
  const unused = async (): Promise<never> => {
    throw new Error('unexpected');
  };
  assert.equal(
    await resolveUpdateNotes('3.0.0', unused, unused, { body: 'release notes' }),
    'release notes',
  );
  assert.equal(
    await resolveUpdateNotes(
      '3.0.0',
      unused,
      async (url) => {
        assert.ok(url.includes('/3.0.0/'));
        return '## [3.0.0]\n- fixed';
      },
      { tag_name: '3.0.0', body: '详见 CHANGELOG.md' },
    ),
    '## [3.0.0]\n- fixed',
  );
});

test('missing release notes never fail version detection', async () => {
  const fail = async (): Promise<never> => {
    throw new Error('offline');
  };
  assert.equal(await resolveUpdateNotes('3.0.0', fail, fail), '');
});
