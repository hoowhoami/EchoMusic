import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformSync } from 'esbuild';
const source = readFileSync(new URL('../src/renderer/miniPlayer/MiniPlayerView.vue', import.meta.url), 'utf8');
const start = source.indexOf('  let nextPlayback = snapshot?.playback');
const end = source.indexOf('  const nextLyric =', start);
const code = transformSync(source.slice(start, end), {loader: 'ts'}).code;
const reconcile = new Function('snapshot', 'playback', 'pendingVolumeRequest', 'pendingVolumeDeadline', `${code}; return { nextPlayback, pendingVolumeRequest };`);
test('old snapshots cannot rewind optimistic volume; latest acknowledgement releases it', () => {
  const local = {value: {volume: 65, lastNonZeroVolume: 65}};
  const deadline = Date.now() + 3000;
  const old = reconcile({playback: {volume: 55, volumeRequestId: 'old', currentTime: 10}}, local, 'latest', deadline);
  assert.equal(old.nextPlayback.volume, 65);
  assert.equal(old.nextPlayback.currentTime, 10);
  assert.equal(old.pendingVolumeRequest, 'latest');
  const ack = reconcile({playback: {volume: 65, volumeRequestId: 'latest'}}, local, 'latest', deadline);
  assert.equal(ack.pendingVolumeRequest, null);
});
test('missing acknowledgement eventually yields to authoritative state', () => {
  const result = reconcile({playback: {volume: 40}}, {value: {volume: 65}}, 'latest', 0);
  assert.equal(result.nextPlayback.volume, 40);
  assert.equal(result.pendingVolumeRequest, null);
});
test('wheel at zero does not restore old volume', () => {
  const code = transformSync(source.slice(source.indexOf('const adjustVolume ='), source.indexOf('const setVolumeFromEvent =')), {loader: 'ts'}).code;
  let value;
  const adjust = new Function('playback', 'normalizePlayerVolume', 'setVolume', `${code}; return adjustVolume;`)({value: {volume: 0, lastNonZeroVolume: 75}}, v => Math.max(0, Math.min(100, v)), v => {value = v;});
  adjust(-5);
  assert.equal(value, 0);
  adjust(5);
  assert.equal(value, 5);
});
