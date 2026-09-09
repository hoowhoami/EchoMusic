import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSync } from 'esbuild';
const source = buildSync({ entryPoints: [new URL('../src/renderer/utils/composerKeyboard.ts', import.meta.url).pathname], bundle: true, format: 'cjs', platform: 'node', write: false }).outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', source)(module, module.exports);
const { handleComposerKeydown } = module.exports;
function press(overrides = {}) {
  let sent = 0, prevented = false, stopped = false;
  handleComposerKeydown({ key: 'Enter', preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; }, ...overrides }, () => { sent++; });
  return { sent, prevented, stopped };
}
test('Enter submits once and prevents native submission/newline and parent shortcuts', () => {
  assert.deepEqual(press(), { sent: 1, prevented: true, stopped: true });
  assert.deepEqual(press({ repeat: true }), { sent: 0, prevented: true, stopped: true });
});
test('Shift Enter preserves newline and IME confirmation never submits', () => {
  for (const overrides of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.deepEqual(press(overrides), { sent: 0, prevented: false, stopped: true });
  }
});
test('other keys and modified Enter do not trigger sends', () => {
  assert.deepEqual(press({ key: 'a' }), { sent: 0, prevented: false, stopped: false });
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) assert.equal(press({ [modifier]: true }).sent, 0);
});
