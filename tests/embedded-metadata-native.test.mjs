import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const addonPath = fileURLToPath(
  new URL('../native/echo-audio-player/echo-audio-player.node', import.meta.url),
);
const fixture = fileURLToPath(
  new URL('../native/echo-audio-player/tests/fixtures/embedded-metadata.flac', import.meta.url),
);
const turn = () => new Promise((resolve) => setImmediate(resolve));

test(
  'Release native reader returns local/Range tags and lyrics without reopening the source',
  { skip: !existsSync(addonPath) },
  async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), 'echo-native-covers-'));
    const addon = require(addonPath);
    const data = readFileSync(fixture);
    const requests = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, range: request.headers.range });
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('Content-Type', 'audio/flac');
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
        response.end();
        return;
      }
      if (match)
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': end - start + 1,
        });
      else response.setHeader('Content-Length', data.length);
      response.end(request.method === 'HEAD' ? undefined : data.subarray(start, end + 1));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/tagged.flac`;
    const events = [];
    addon.registerEventHandler((error, event) => {
      if (!error) events.push(event);
    });
    addon.initialize({ demuxerReadaheadSecs: 0.2 });
    addon.setVolume(0);
    addon.setTransitionSettings({ mode: 'none' });
    try {
      for (const [source, seq] of [
        [fixture, 701],
        [url, 702],
      ]) {
        await addon.loadFile(source, seq);
        await turn();
        const before = requests.length;
        const text = await addon.getEmbeddedMetadata(seq);
        assert.equal(text.title, '内嵌标题');
        assert.equal(text.artist, '内嵌歌手');
        assert.equal(text.album, '内嵌专辑');
        assert.equal(text.lyric, '[00:01.00]内嵌歌词');
        assert.equal(text.coverFile, undefined);
        const all = await addon.getEmbeddedMetadata(seq, cacheDir);
        assert.equal(all.cover, undefined, 'artwork bytes must never cross N-API');
        const cover = await readFile(path.join(cacheDir, all.coverFile));
        assert.equal(cover.length, 68);
        assert.equal(all.coverFile, `${createHash('sha256').update(cover).digest('hex')}.png`);
        const concurrent = await Promise.all(
          Array.from({ length: 8 }, () => addon.getEmbeddedMetadata(seq, cacheDir)),
        );
        assert(concurrent.every((item) => item.coverFile === all.coverFile));
        assert.equal((await readdir(cacheDir)).length, 1);
        const blocked = path.join(cacheDir, 'not-a-directory');
        await writeFile(blocked, 'blocked');
        const withoutCover = await addon.getEmbeddedMetadata(seq, blocked);
        assert.equal(withoutCover.artist, text.artist);
        assert.equal(withoutCover.lyric, text.lyric);
        assert.equal(withoutCover.coverFile, undefined);
        await rm(blocked);
        for (let i = 0; i < 5; i++) await addon.getEmbeddedMetadata(seq, cacheDir);
        await turn();
        assert.equal(requests.length, before, 'metadata export must not issue HTTP requests');
        assert.equal(await addon.getEmbeddedMetadata(seq - 1, cacheDir), null);
        assert.equal(await addon.getEmbeddedMetadata(seq + 0.5, cacheDir), null);
      }
      assert(
        requests.some((request) => request.range),
        'native playback must exercise HTTP Range',
      );
      // Preparing the next source does not expose its metadata until actual activation.
      const requestId = addon.beginNextSourcePreparation();
      assert.equal(await addon.prepareNextSource(fixture, null, 703, requestId, 0), true);
      assert.equal(await addon.getEmbeddedMetadata(703, cacheDir), null);
      assert.equal((await addon.getEmbeddedMetadata(702)).artist, '内嵌歌手');
      await addon.play();
      assert.equal(await addon.commitPreparedNextSource(0), true);
      // The boundary is driven by audio output; render silence until it is acknowledged.
      addon.setVolume(0);
      await addon.play();
      const deadline = Date.now() + 3000;
      while (
        Date.now() < deadline &&
        !events.some((event) => event.event === 'file-loaded' && event.seq === 703)
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert(events.some((event) => event.event === 'file-loaded' && event.seq === 703));
      assert.equal((await addon.getEmbeddedMetadata(703)).lyric, '[00:01.00]内嵌歌词');
      assert.equal(await addon.getEmbeddedMetadata(702, cacheDir), null);
      addon.stop();
      assert.equal(await addon.getEmbeddedMetadata(703, cacheDir), null);
    } finally {
      addon.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(cacheDir, { recursive: true, force: true });
    }
  },
);
