import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../src/renderer/components/music/ImportPlaylistDialog.vue', import.meta.url),
  'utf8',
);

test('local fallback confirms a duplicate name before creating its playlist', () => {
  assert.match(
    source,
    /const playlistName = await confirmDuplicatePlaylistName\([\s\S]*?resolved\.playlist\.name[\s\S]*?createPlaylistAndReturnId\(/,
  );
});

test('new screenshot playlists confirm a duplicate name before creation', () => {
  assert.match(
    source,
    /if \(screenshotTarget\.value === 'new'\) \{[\s\S]*?confirmDuplicatePlaylistName\(playlistName, run\)[\s\S]*?createPlaylistAndReturnId\(/,
  );
});

test('duplicate-name confirmation requires an explicit decision', () => {
  assert.match(source, /title="歌单名称重复"/);
  assert.match(source, /v-model="duplicatePlaylistName"/);
  assert.match(source, /你可以修改名称，或保留原名称继续创建/);
  assert.match(source, /:disabled="!duplicatePlaylistName\.trim\(\)"/);
  assert.match(source, /finishDuplicateNameConfirm\(false\)[^>]*>取消<\/Button>/);
  assert.match(source, /@click="finishDuplicateNameConfirm\(true\)"/);
  assert.match(source, /:close-on-escape="false"/);
  assert.match(source, /:close-on-interact-outside="false"/);
});
