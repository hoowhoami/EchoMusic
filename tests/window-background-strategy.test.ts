import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectWindowBackgroundStrategy,
  isHyprlandEnvironment,
  resolveWindowBackgroundCapabilities,
} from '../src/shared/window-background-strategy.ts';

test('Hyprland detection accepts its instance signature and desktop identifiers', () => {
  assert.equal(isHyprlandEnvironment({ HYPRLAND_INSTANCE_SIGNATURE: 'abc123' }), true);
  assert.equal(isHyprlandEnvironment({ XDG_CURRENT_DESKTOP: 'Hyprland' }), true);
  assert.equal(isHyprlandEnvironment({ XDG_CURRENT_DESKTOP: 'hyprland:wlroots' }), true);
  assert.equal(isHyprlandEnvironment({ XDG_CURRENT_DESKTOP: 'KDE' }), false);
  assert.equal(
    detectWindowBackgroundStrategy({
      platform: 'linux',
      env: { XDG_SESSION_DESKTOP: 'Hyprland' },
    }),
    'hyprland',
  );
  assert.equal(
    detectWindowBackgroundStrategy({
      platform: 'darwin',
      env: { HYPRLAND_INSTANCE_SIGNATURE: 'abc123' },
    }),
    'default',
  );
});

test('Hyprland uses compositor blur and pure transparency', () => {
  assert.deepEqual(
    resolveWindowBackgroundCapabilities({ platform: 'linux', build: 0, strategy: 'hyprland' }),
    {
      strategy: 'hyprland',
      supportsFrost: true,
      frostBackend: 'hyprland-blur',
      frostMode: 'compositor',
      frostLive: true,
      live: false,
      transparentMode: 'pure',
    },
  );
});

test('non-Hyprland Linux keeps the existing no-frost, layered behavior', () => {
  assert.deepEqual(resolveWindowBackgroundCapabilities({ platform: 'linux', build: 0 }), {
    strategy: 'default',
    supportsFrost: false,
    frostBackend: 'none',
    frostMode: 'none',
    frostLive: false,
    live: false,
    transparentMode: 'layered',
  });
});
