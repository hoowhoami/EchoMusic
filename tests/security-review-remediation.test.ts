import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBirthdayForInput } from '../src/shared/birthday.ts';
import { assertBackupManifestMatchesPlugin } from '../src/shared/settingsBackupValidation.ts';
import { MAX_AVATAR_BYTES, prepareAvatarUploadQuery } from '../src/main/avatarUpload.ts';

test('backup manifest id must exactly match archive metadata', () => {
  assert.doesNotThrow(() => assertBackupManifestMatchesPlugin('plugin-a', { id: 'plugin-a' }));
  assert.throws(
    () => assertBackupManifestMatchesPlugin('plugin-a', { id: 'plugin-b' }),
    /id 与元数据不一致/,
  );
  assert.throws(
    () => assertBackupManifestMatchesPlugin('plugin-a', { id: 'Plugin-A' }),
    /id 与元数据不一致/,
  );
});

test('numeric birthdays are formatted using UTC calendar fields', () => {
  const milliseconds = Date.UTC(2000, 0, 1, 23, 30, 0);
  assert.equal(formatBirthdayForInput(milliseconds), '2000-01-01');
  assert.equal(formatBirthdayForInput(Math.floor(milliseconds / 1000)), '2000-01-01');
  assert.equal(formatBirthdayForInput('2000/2/3'), '2000-02-03');
});

test('avatar upload validation overwrites unsafe filenames and rejects unsupported or large input', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
  const query = prepareAvatarUploadQuery({
    imgFile: jpeg,
    filename: 'avatar.jpg\r\nX-Injected: value',
  });
  assert.equal(query.filename, 'avatar.jpg');

  assert.throws(() => prepareAvatarUploadQuery({ imgFile: Buffer.from('BMxxxx') }), /仅支持/);
  const oversized = Buffer.alloc(MAX_AVATAR_BYTES + 1);
  oversized[0] = 0xff;
  oversized[1] = 0xd8;
  assert.throws(() => prepareAvatarUploadQuery({ imgFile: oversized }), /8 MB/);
});
