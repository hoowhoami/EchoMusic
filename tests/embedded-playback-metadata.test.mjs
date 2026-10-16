import * as embeddedTags from '../src/shared/embeddedMetadata.ts';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, readFile, writeFile, truncate, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
import {
  applyEmbeddedMetadata,
  createEmbeddedMetadataCompleter,
  missingEmbeddedMetadata,
} from '../src/renderer/stores/player/embeddedMetadata.ts';

const require = createRequire(import.meta.url);
const load = (file, dependencies = {}) => {
  const module = { exports: {} };
  const code = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    loader: 'ts',
    format: 'cjs',
  }).code;
  new Function('require', 'module', 'exports', code)(
    (name) => (name in dependencies ? dependencies[name] : require(name)),
    module,
    module.exports,
  );
  return module.exports;
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const emptySong = (patch = {}) => ({
  id: 'file-a',
  hash: 'original-hash',
  title: 'File name',
  name: 'File name',
  artist: '未知歌手',
  albumName: '',
  album: '',
  coverUrl: '',
  duration: 20,
  source: 'local',
  mixSongId: 0,
  audioUrl: 'file:///music.flac',
  ...patch,
});
const embedded = {
  title: 'Tag title',
  artist: 'Tag artist',
  album: 'Tag album',
  coverUrl: 'echo-player-cover://artwork/test.png',
  lyric: '[00:01.00]内嵌歌词\n[00:02.00]第二行',
};
function fixture({ song = emptySong(), read = async () => embedded } = {}) {
  const state = { seq: 10, requestSeq: 1, song };
  const calls = { reads: [], commits: [], errors: [], clears: [], lyrics: [], searches: [] };
  const lyricStore = {
    loadedHash: song.hash,
    rawLyric: '',
    lines: [],
    clear(hash) {
      calls.clears.push(hash);
      this.rawLyric = '';
      this.lines = [];
    },
    async fetchLyrics(hash, options) {
      calls.searches.push([hash, options]);
    },
    setLyric(content, hash) {
      calls.lyrics.push([content, hash]);
      this.rawLyric = content;
    },
  };
  let session = 1;
  const complete = createEmbeddedMetadataCompleter({
    current: () => state,
    captureSession: () => {
      const captured = session;
      return () => captured === session;
    },
    read: (...args) => {
      calls.reads.push(args);
      return read(...args);
    },
    lyrics: lyricStore,
    commit: (previous, next) => {
      calls.commits.push([previous, next]);
      state.song = next;
    },
    onError: (error) => calls.errors.push(error),
  });
  return { state, calls, lyricStore, complete, switchAccount: () => session++ };
}

test('local, cloud and plugin songs fill only missing display fields and preserve playback identity', () => {
  for (const source of ['local', 'cloud', 'plugin:example', undefined]) {
    const original = emptySong({ source, albumId: '456', fileId: '789', cloudFileId: 12 });
    const next = applyEmbeddedMetadata(original, embedded);
    assert.equal(next.title, original.title);
    assert.equal(next.name, original.name);
    assert.equal(next.artist, embedded.artist);
    assert.equal(next.albumName, embedded.album);
    assert.equal(next.album, embedded.album);
    assert.equal(next.coverUrl, embedded.coverUrl);
    assert.deepEqual(next.artists, [{ name: embedded.artist }]);
    assert.equal(next.lyric, undefined);
    assert.equal(next.embeddedMetadata.lyric, embedded.lyric);
    for (const key of [
      'id',
      'hash',
      'source',
      'albumId',
      'fileId',
      'cloudFileId',
      'audioUrl',
      'mixSongId',
    ])
      assert.equal(next[key], original[key]);
    assert.equal(original.artist, '未知歌手');
  }
});

test('API values, artist arrays, album aliases and existing lyrics remain authoritative', () => {
  const song = emptySong({
    artist: 'API artist',
    artists: [{ id: 1, name: 'API artist' }],
    album: 'API album',
    cover: 'https://cover.test/image.jpg',
    lyric: '[00:00.00]Existing lyric',
  });
  const completed = applyEmbeddedMetadata(song, embedded);
  assert.equal(completed.artist, song.artist);
  assert.equal(completed.album, song.album);
  assert.equal(completed.cover, song.cover);
  assert.equal(completed.lyric, song.lyric);
  assert.equal(
    applyEmbeddedMetadata({ ...song, lyric: embedded.lyric }, embedded).lyric,
    embedded.lyric,
  );
  assert.deepEqual(completed.embeddedMetadata, {
    title: embedded.title,
    artist: embedded.artist,
    lyric: embedded.lyric,
  });
  assert.equal(missingEmbeddedMetadata(emptySong({ artists: [{ name: 'Known' }] })).artist, false);
  const title = applyEmbeddedMetadata(emptySong({ title: '未知歌曲', name: '' }), embedded);
  assert.equal(title.title, embedded.title);
});

test('complete songs still discover current embedded lyrics, without repeating successful online search', async () => {
  const f = fixture({
    song: emptySong({
      artist: 'Singer',
      album: 'Album',
      coverUrl: 'Cover',
      lyric: '[00:01.00]Lyric',
    }),
  });
  f.lyricStore.detailResolved = true;
  f.lyricStore.rawLyric = 'Online lyrics';
  await f.complete();
  f.state.song = emptySong();
  f.state.seq = null;
  await f.complete();
  assert.equal(f.calls.reads.length, 1);
  assert.equal(f.calls.searches.length, 0);
});

test('one optional IPC read per active occurrence, artwork requested only when missing', async () => {
  const gate = deferred();
  const f = fixture({ song: emptySong({ coverUrl: 'API cover' }), read: () => gate.promise });
  const pending = f.complete();
  await f.complete();
  assert.deepEqual(f.calls.reads, [[10, false]]);
  gate.resolve(embedded);
  await pending;
  assert.equal(f.state.song.coverUrl, 'API cover');
  assert.equal(f.calls.lyrics.length, 0);
  assert.equal(f.calls.clears.length, 0);
  assert.equal(f.calls.searches.length, 1);
});

for (const kind of ['track', 'same-track-replay', 'account']) {
  test(`late metadata is discarded after ${kind} changes`, async () => {
    const gate = deferred();
    const f = fixture({ read: () => gate.promise });
    const pending = f.complete();
    if (kind === 'track') {
      f.state.seq++;
      f.state.song = emptySong({ id: 'file-b' });
    }
    if (kind === 'same-track-replay') f.state.requestSeq++;
    if (kind === 'account') f.switchAccount();
    gate.resolve(embedded);
    await pending;
    assert.equal(f.calls.commits.length, 0);
    assert.equal(f.calls.lyrics.length, 0);
  });
}

test('late tags cannot overwrite metadata or lyrics that arrived during IPC', async () => {
  const gate = deferred();
  const f = fixture({ read: () => gate.promise });
  const pending = f.complete();
  f.state.song = { ...f.state.song, artist: 'New API singer' };
  f.lyricStore.rawLyric = '[00:00.00]Online lyric';
  f.lyricStore.lines = [{}];
  f.lyricStore.detailResolved = true;
  gate.resolve(embedded);
  await pending;
  assert.equal(f.state.song.artist, 'New API singer');
  assert.equal(f.state.song.lyric, undefined);
  assert.equal(f.calls.clears.length, 0);
});

test('unavailable/failed metadata remains optional and raw plain lyrics are returned unchanged', async () => {
  const f = fixture({
    read: async () => {
      throw new Error('IPC unavailable');
    },
  });
  await assert.doesNotReject(f.complete());
  assert.equal(f.calls.errors.length, 1);
  const plain = fixture({ read: async () => ({ lyric: '第一行\n第二行' }) });
  await plain.complete();
  assert.equal(plain.state.song.embeddedMetadata.lyric, '第一行\n第二行');
  assert.equal(plain.state.song.lyric, undefined);
  assert.equal(plain.calls.searches.length, 1);
});

const { EmbeddedCoverCache } = load('../src/main/player/embeddedCoverCache.ts');
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9O8AAAAASUVORK5CYII=',
  'base64',
);
test('cover cache adopts native files, bounds storage and rejects unsafe/invalid resources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'echo-embedded-cover-'));
  try {
    const cache = new EmbeddedCoverCache(root);
    const name = `${createHash('sha256').update(pixel).digest('hex')}.png`;
    await writeFile(path.join(root, name), pixel);
    const [first, second] = await Promise.all([cache.adopt(name), cache.adopt(name)]);
    assert.equal(first, second);
    assert.equal((await readdir(root)).length, 1);
    const image = await cache.resolve(first);
    assert.equal(image.size, pixel.length);
    assert.equal(image.mime, 'image/png');
    assert.deepEqual(await readFile(image.filePath), pixel);
    assert.equal(await cache.adopt('../secret'), undefined);
    assert.equal(await cache.adopt('a'.repeat(64) + '.png'), undefined);
    const invalidName = 'b'.repeat(64) + '.png';
    await writeFile(path.join(root, invalidName), '<svg>unsafe</svg>');
    assert.equal(await cache.adopt(invalidName), undefined);
    await rm(path.join(root, invalidName));
    const oversizedName = 'c'.repeat(64) + '.png';
    await writeFile(path.join(root, oversizedName), pixel);
    await truncate(path.join(root, oversizedName), 8 * 1024 * 1024 + 1);
    assert.equal(await cache.adopt(oversizedName), undefined);
    await rm(path.join(root, oversizedName));
    const symlinkName = 'd'.repeat(64) + '.png';
    await symlink(path.join(root, name), path.join(root, symlinkName));
    assert.equal(await cache.adopt(symlinkName), undefined);
    await rm(path.join(root, symlinkName));
    for (const url of [
      'file:///etc/passwd',
      'echo-player-cover://artwork/../secret',
      first + '?x=1',
    ])
      assert.equal(await cache.resolve(url), null);
    for (let i = 0; i < 130; i++) {
      const next = i.toString(16).padStart(64, '0') + '.png';
      await writeFile(path.join(root, next), pixel);
      await cache.adopt(next);
    }
    assert.equal((await readdir(root)).length, 128);
    // The byte budget also applies before reaching the file-count limit.
    for (let i = 200; i < 210; i++) {
      const next = i.toString(16).padStart(64, '0') + '.png';
      await writeFile(path.join(root, next), pixel);
      await truncate(path.join(root, next), 8 * 1024 * 1024);
      assert(await cache.adopt(next));
    }
    assert((await readdir(root)).length <= 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cover protocol waits for app readiness and registers existing/new sessions only once', async () => {
  const ready = deferred();
  const app = new EventEmitter();
  let isReady = false;
  let reads = 0;
  const registrations = [];
  app.whenReady = () => ready.promise;
  const target = { protocol: { handle: (...args) => registrations.push(args) } };
  const session = {
    get defaultSession() {
      assert.equal(isReady, true, 'defaultSession must not be accessed before ready');
      reads++;
      return target;
    },
  };
  const service = load('../src/main/player/embeddedMetadata.ts', {
    electron: { app, session },
    './embeddedCoverCache': { EmbeddedCoverCache, EMBEDDED_COVER_SCHEME: 'echo-player-cover' },
    '../logger': { warn() {} },
  });
  service.registerEmbeddedCoverProtocol();
  service.registerEmbeddedCoverProtocol();
  assert.equal(reads, 0);
  assert.equal(registrations.length, 0);
  isReady = true;
  ready.resolve();
  await ready.promise;
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.equal(registrations.length, 1);
  app.emit('session-created', target);
  assert.equal(registrations.length, 1);
  app.emit('session-created', { protocol: target.protocol });
  assert.equal(registrations.length, 2);
});

test('plain embedded lyrics retain the authoritative file identity and request online timestamps', async () => {
  const f = fixture({
    song: emptySong({ title: 'Li Yi-Feng - 劍傷.m4a', artist: 'Li Yi-Feng' }),
    read: async () => ({ title: '剑伤', artist: '李易峰', lyric: '世间多纷扰 生死困顿寂寥' }),
  });
  await f.complete();
  assert.deepEqual(f.state.song.embeddedMetadata, {
    title: '剑伤',
    artist: '李易峰',
    lyric: '世间多纷扰 生死困顿寂寥',
  });
  assert.equal(f.calls.clears.length, 0);
  assert.equal(f.calls.lyrics.length, 0);
  assert.equal(f.calls.searches.length, 1);
  assert.equal(f.calls.searches[0][1].track, f.state.song);
  assert.equal(f.calls.searches[0][1].duration, 20000);
  assert.equal(f.calls.searches[0][1].isCurrent(), true);
  f.switchAccount();
  assert.equal(f.calls.searches[0][1].isCurrent(), false);
});

test('an empty reader result does not repeat the existing online hash lookup', async () => {
  const f = fixture({ read: async () => ({}) });
  await f.complete();
  assert.equal(f.calls.searches.length, 0);
});

test('a remembered embedded choice still reads the active reader after online lyrics have loaded', async () => {
  const f = fixture({ song: emptySong({ artist: 'Singer', album: 'Album', coverUrl: 'Cover' }) });
  f.lyricStore.rawLyric = '[00:01.00]Online';
  f.lyricStore.lines = [{}];
  f.lyricStore.detailResolved = true;
  f.lyricStore.embeddedLyricSelectionMap = { [f.state.song.hash]: true };
  await f.complete();
  assert.equal(f.calls.reads.length, 1);
  assert.equal(f.state.song.embeddedMetadata.lyric, embedded.lyric);
  assert.equal(f.calls.searches.length, 1);
});

const queueHelpers = load('../src/renderer/stores/playlist/helpers.ts', {
  vue: require('vue'),
  '@/utils/song': load('../src/renderer/utils/song.ts'),
  './constants': load('../src/renderer/stores/playlist/constants.ts'),
  '../../../shared/embeddedMetadata': embeddedTags,
});

test('adding the active song to a retained list drops reader data without mutating the active snapshot', () => {
  const current = applyEmbeddedMetadata(emptySong({ lyric: 'Existing API lyric' }), embedded);
  const ordinary = emptySong({ id: 'ordinary' });
  const retained = queueHelpers.toRawSongList([current, ordinary]);
  assert.equal(retained[0].embeddedMetadata, undefined);
  assert.equal(retained[0].lyric, 'Existing API lyric');
  assert.equal(retained[0].coverUrl, embedded.coverUrl);
  assert.equal(retained[0].hash, current.hash);
  assert.equal(retained[1], ordinary);
  assert.equal(current.embeddedMetadata.lyric, embedded.lyric);
  assert.equal(queueHelpers.toRawSongList(retained), retained);
});

test('normalizing an already-raw list also removes reader snapshots', () => {
  const current = applyEmbeddedMetadata(emptySong(), embedded);
  const raw = require('vue').markRaw([current]);
  const retained = queueHelpers.toRawSongList(raw);
  assert.notEqual(retained, raw);
  assert.equal(retained[0].embeddedMetadata, undefined);
  assert.equal(current.embeddedMetadata.lyric, embedded.lyric);
});

test('replay requests embedded artwork again while ordinary online covers stay untouched', async () => {
  for (const coverUrl of ['', 'echo-player-cover://artwork/' + 'a'.repeat(64) + '.png', 'https://cover.test/online.jpg']) {
    const f = fixture({ song: emptySong({ artist: 'Singer', album: 'Album', coverUrl }) });
    f.lyricStore.detailResolved = true;
    f.lyricStore.rawLyric = 'Online lyrics';
    await f.complete();
    assert.deepEqual(f.calls.reads, [[10, !coverUrl || coverUrl.startsWith('echo-player-cover:')]]);
    await f.complete();
    assert.equal(f.calls.reads.length, 1, 'the same playback occurrence must not export twice');
    f.state.seq++;
    f.state.requestSeq++;
    f.state.song = embeddedTags.withoutEmbeddedMetadata(f.state.song);
    await f.complete();
    assert.equal(f.calls.reads[1][1], !coverUrl || coverUrl.startsWith('echo-player-cover:'));
    assert.equal(f.calls.searches.length, 0, 'artwork renewal must not repeat successful lyric queries');
  }
});


test('Release native replay restores artwork after actual cache eviction', {
  skip: !existsSync(new URL('../native/echo-audio-player/echo-audio-player.node', import.meta.url)),
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'echo-cover-replay-'));
  const cache = new EmbeddedCoverCache(root);
  const addon = require('../native/echo-audio-player/echo-audio-player.node');
  const source = fileURLToPath(new URL('../native/echo-audio-player/tests/fixtures/embedded-metadata.flac', import.meta.url));
  addon.initialize({ demuxerReadaheadSecs: 0.2 });
  addon.setVolume(0);
  const f = fixture({ read: async (seq, includeCover) => {
    const tags = await addon.getEmbeddedMetadata(seq, includeCover ? cache.directory : undefined);
    return tags ? { ...tags, coverUrl: tags.coverFile ? await cache.adopt(tags.coverFile) : undefined } : null;
  } });
  f.lyricStore.rawLyric = 'Online lyrics';
  f.lyricStore.detailResolved = true;
  try {
    await addon.loadFile(source, f.state.seq);
    await f.complete();
    const originalUrl = f.state.song.coverUrl;
    const retainedSong = embeddedTags.withoutEmbeddedMetadata(f.state.song);
    const image = await cache.resolve(originalUrl);
    const originalBytes = await readFile(image.filePath);
    for (let i = 0; i < 128; i++) {
      const data = Buffer.concat([pixel, Buffer.from(String(i))]);
      const name = createHash('sha256').update(data).digest('hex') + '.png';
      await writeFile(path.join(root, name), data);
      await cache.adopt(name);
    }
    assert.equal((await readdir(root)).length, 128);
    assert.equal(await cache.resolve(originalUrl), null, 'the cover must actually be evicted');
    f.state.seq++;
    f.state.requestSeq++;
    f.state.song = retainedSong;
    await addon.loadFile(source, f.state.seq);
    await f.complete();
    await f.complete();
    assert.deepEqual(f.calls.reads, [[10, true], [11, true]]);
    assert.notEqual(f.state.song.coverUrl, originalUrl, 'recreated artwork must retry an already failed image URL');
    assert.equal(new URL(f.state.song.coverUrl).pathname, new URL(originalUrl).pathname);
    const restored = await cache.resolve(f.state.song.coverUrl);
    assert(restored, 'replay must republish the evicted native cover');
    assert.deepEqual(await readFile(restored.filePath), originalBytes);
    assert.equal((await readdir(root)).length, 128);
    assert.equal(f.calls.searches.length, 0);
  } finally {
    addon.destroy();
    await rm(root, {recursive: true, force: true});
  }
});
