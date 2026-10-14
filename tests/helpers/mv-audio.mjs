import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as object from '../../src/shared/object.ts';
import * as session from '../../src/renderer/utils/userSession.ts';

function compile(path, dependencies) {
  const code = transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected MV dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
  );
  return module.exports;
}

const mapper = compile('../../src/renderer/utils/mappers/video.ts', {
  '@/utils/cover': { normalizeCoverUrl: (value) => value },
  '@/utils/videoCollection': { normalizeVideoId: (value) => String(value ?? '') },
  '../../../shared/object': object,
});

export function loadMvAudio(
  api = {},
  user = { isLoggedIn: false, accountRevision: 0, info: null },
) {
  return compile('../../src/renderer/stores/player/mvAudio.ts', {
    '@/api/video': api,
    '../user': { useUserStore: () => user },
    '@/utils/userSession': session,
    '@/utils/mappers/video': mapper,
    '@/utils/logger': { warn() {}, info() {} },
    '../../../shared/object': object,
  });
}

export const officialMv = (patch = {}) => ({
  album_audio_id: 123,
  video_id: 456,
  mv_name: 'Song',
  duration: 240000,
  is_recommend: 1,
  is_publish: 1,
  is_ugc: 0,
  is_short: 0,
  is_other: 0,
  tags: [{ tag_name: '官方版' }],
  h264: { ld_hash: 'SMALL264', ld_filesize: 20000000, fhd_hash: 'BIG264', fhd_filesize: 100000000 },
  h265: { sd_hash: 'SMALL265', sd_filesize: 14000000 },
  mkv: { sd_hash: 'MKV', sd_filesize: 24000000 },
  ...patch,
});
