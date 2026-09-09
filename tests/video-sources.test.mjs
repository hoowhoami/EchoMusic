import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

function load(
  path,
  require = () => {
    throw new Error('unexpected import');
  },
) {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  runInNewContext(code, { module, require });
  return module.exports;
}
const objects = load('../src/shared/object.ts');
const { mapVideoMeta, mapVideoSourcesFromPrivilege, mergeVideoSources, pickDefaultVideoSource } =
  load('../src/renderer/utils/mappers/video.ts', (name) => {
    if (name === '@/utils/cover') return { normalizeCoverUrl: (url) => url };
    if (name === '../../../shared/object') return objects;
    throw new Error(name);
  });

test('MV retains every available quality and codec, ignoring empty hashes', () => {
  const meta = mapVideoMeta({
    data: [
      [
        {
          hash: 'mv',
          h265: { fhd_hash: 'hevc1080', hd_hash: 'hevc720' },
          h264: { fhd_hash: 'avc1080', sd_hash: 'avc432', ld_hash: '' },
          mkv: { hd_hash: 'mkv720' },
        },
      ],
    ],
  });
  assert.equal(meta.sources.length, 5);
  assert.deepEqual(Array.from(meta.sources, (source) => source.hash).sort(), [
    'avc1080',
    'avc432',
    'hevc1080',
    'hevc720',
    'mkv720',
  ]);
  assert.equal(pickDefaultVideoSource(meta.sources).hash, 'avc1080');
});

test('privilege lists retain all entries and merging preserves known codec identity', () => {
  const sources = mapVideoSourcesFromPrivilege({
    data: [{ hash: 'ABC', level: 5 }, { hash: 'other', level: 4 }, { hash: '' }],
  });
  assert.equal(sources.length, 2);
  const merged = mergeVideoSources(
    [{ hash: 'abc', codec: 'H.264', height: 1080, width: 1920, label: '1080P', url: '' }],
    sources,
  );
  assert.equal(merged.length, 2);
  assert.equal(pickDefaultVideoSource(merged).codec, 'H.264');
});

test('default source falls back without hiding HEVC or other sources', () => {
  const source = { hash: 'hevc', codec: 'H.265' };
  assert.equal(pickDefaultVideoSource([source]), source);
  assert.equal(pickDefaultVideoSource([]), null);
});
