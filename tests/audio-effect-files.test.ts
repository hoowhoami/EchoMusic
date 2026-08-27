import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createImportedAudioEffectId } from '../src/main/audioEffectFiles.ts';

test('local convolution IDs use the file content SHA-256 instead of its path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'echo-audio-effect-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first.wav');
  const renamed = join(directory, 'renamed.irs');
  await Promise.all([writeFile(first, 'abc'), writeFile(renamed, 'abc')]);

  const expected = 'local-ir-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(await createImportedAudioEffectId(first), expected);
  assert.equal(await createImportedAudioEffectId(renamed), expected);

  await writeFile(renamed, 'changed');
  assert.notEqual(await createImportedAudioEffectId(renamed), expected);
});
