import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
function compile(file, mocks) {
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => (name in mocks ? mocks[name] : require(name)),
    mod,
    mod.exports,
  );
  return mod.exports;
}
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
test('audio scanning bounds parallel metadata reads, preserves order, and retains fallback names on corrupt files', async () => {
  const pending = new Map();
  let active = 0,
    peak = 0;
  const files = Array.from({ length: 12 }, (_, index) => ({
    path: String(index),
    name: `file${index}.mp3`,
    relativePath: `${index}.mp3`,
    extension: '.mp3',
    size: 10,
    modifiedAt: 1,
  }));
  const { scanLocalAudioFiles } = compile('../src/main/localMusic.ts', {
    '../shared/localMusic': { LOCAL_AUDIO_EXTENSIONS: ['mp3'] },
    './media/fileScanner': {
      scanLocalFiles: async () => ({ root: '/music', files, limitReached: true }),
    },
    './media/audioMetadata': {
      readAudioMetadata(path) {
        active++;
        peak = Math.max(peak, active);
        return new Promise((resolve, reject) => pending.set(path, { resolve, reject })).finally(
          () => {
            active--;
          },
        );
      },
      resolveAudioTitleAndArtist: (name, tags) => ({ title: tags?.title ?? name }),
    },
  });
  const task = scanLocalAudioFiles('/music');
  await flush();
  assert.equal(pending.size, 4);
  for (let batch = 0; batch < 3; batch++) {
    for (let index = batch * 4 + 3; index >= batch * 4; index--) {
      if (index === 2) pending.get(String(index)).reject(new Error('corrupt tag'));
      else pending.get(String(index)).resolve({ title: `title${index}`, duration: index });
    }
    await flush();
  }
  const result = await task;
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.deepEqual(
    result.files.map((file) => file.path),
    files.map((file) => file.path),
  );
  assert.equal(result.files[2].title, 'file2.mp3');
  assert.equal(result.files[11].title, 'title11');
  assert.equal(result.limitReached, true);
});
test('an empty audio folder performs no metadata reads', async () => {
  const { scanLocalAudioFiles } = compile('../src/main/localMusic.ts', {
    '../shared/localMusic': { LOCAL_AUDIO_EXTENSIONS: ['mp3'] },
    './media/fileScanner': {
      scanLocalFiles: async () => ({ root: '/music', files: [], limitReached: false }),
    },
    './media/audioMetadata': {
      readAudioMetadata() {
        assert.fail('unexpected metadata read');
      },
    },
  });
  assert.deepEqual((await scanLocalAudioFiles('/music')).files, []);
});
test('extension filtering skips stat calls for irrelevant files and retains scan constraints', async () => {
  const stats = [];
  const tree = {
    '/music': [
      { name: 'nested', isDirectory: () => true },
      ...['a.MP3', 'notes.txt', '.hidden.mp3', 'huge.mp3', 'b.mp3'].map((name) => ({
        name,
        isDirectory: () => false,
        isFile: () => true,
      })),
    ],
    '/music/nested': [{ name: 'child.mp3', isDirectory: () => false, isFile: () => true }],
  };
  const fs = {
    realpath: async (path) => path,
    readdir: async (path) => tree[path],
    stat: async (path) => {
      stats.push(path);
      return {
        isDirectory: () => path === '/music',
        size: path.endsWith('huge.mp3') ? 10000 : 10,
        mtimeMs: 1,
      };
    },
  };
  const { scanLocalFiles } = compile('../src/main/media/fileScanner.ts', { 'fs/promises': fs });
  const result = await scanLocalFiles('/music', {
    extensions: ['mp3'],
    recursive: true,
    maxFileSize: 100,
    limit: 3,
  });
  assert.equal(stats.includes('/music/notes.txt'), false);
  assert.equal(stats.includes('/music/.hidden.mp3'), false);
  assert.deepEqual(
    result.files.map((file) => file.relativePath),
    ['a.MP3', 'b.mp3', 'nested/child.mp3'],
  );
  assert.equal(result.limitReached, true);
});
