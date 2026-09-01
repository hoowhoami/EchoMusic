import assert from 'node:assert/strict';
import test from 'node:test';
import { formatShortcutRegistrationFailures } from '../src/shared/shortcut-registration.ts';
import type { ShortcutRegistrationFailure } from '../src/shared/shortcuts.ts';

test('明确标识全局快捷键冲突', () => {
  const failures: ShortcutRegistrationFailure[] = [
    {
      command: 'togglePlayback',
      accelerator: 'CommandOrControl+Space',
      scope: 'global',
      reason: 'conflict',
    },
  ];

  assert.equal(
    formatShortcutRegistrationFailures(failures, () => 'Ctrl+Space'),
    '全局快捷键“播放 / 暂停” (Ctrl+Space) 可能与其他软件冲突',
  );
});

test('明确标识普通快捷键格式无效', () => {
  const failures: ShortcutRegistrationFailure[] = [
    {
      command: 'nextTrack',
      accelerator: 'invalid-shortcut',
      scope: 'local',
      reason: 'invalid',
    },
  ];

  assert.equal(
    formatShortcutRegistrationFailures(failures),
    '普通快捷键“下一首” (invalid-shortcut) 格式无效',
  );
});

test('混合失败列表保留每一项的快捷键作用域', () => {
  const failures: ShortcutRegistrationFailure[] = [
    {
      command: 'toggleMute',
      accelerator: 'Ctrl+M',
      scope: 'global',
      reason: 'conflict',
    },
    {
      command: 'volumeUp',
      accelerator: 'Ctrl+Up',
      scope: 'local',
      reason: 'conflict',
    },
  ];

  assert.equal(
    formatShortcutRegistrationFailures(failures),
    '全局快捷键“静音” (Ctrl+M) 可能与其他软件冲突；普通快捷键“音量 +” (Ctrl+Up) 可能与其他软件冲突',
  );
});

test('没有失败项时返回空文本', () => {
  assert.equal(formatShortcutRegistrationFailures([]), '');
});
