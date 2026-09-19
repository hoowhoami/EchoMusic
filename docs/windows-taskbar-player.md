# Windows taskbar player

Settings → Window → **任务栏快捷播控（独立横条）** enables an optional standalone horizontal player. It is separate from the taskbar icon's thumbnail controls and does not replace Mini mode. The existing three thumbnail transport buttons remain, with an additional favorite toggle; the cover-preview setting controls the compact preview card.

## Behavior

- Displays cover art, title/artist, current lyric, previous/play/next and favorite controls. The progress slider appears on hover or keyboard focus.
- Reuses the main player's now-playing snapshot and command channel, including the upstream absolute seek command. `useDeferredSeek` handles gesture preview; switching tracks or canceling a gesture cannot seek a different track.
- Follows the Windows system/taskbar theme rather than the independently selected application theme.
- Positions itself inside an identified free interval of a horizontal taskbar, using physical shell rectangles converted to Electron DIPs. Start, task buttons and tray controls are excluded.
- If shell geometry is unavailable, the bar is crowded, vertical or auto-hidden, it falls back beside the taskbar in the usable desktop area. This is not an Explorer deskband and does not promise exact parity with third-party players on every shell configuration.
- Drag the metadata area to detach. The context menu can dock it again, expand it into a small window, show the main app, or close the bar. “重新显示” in settings restores/recreates it.
- Docked mode hides for a detected fullscreen foreground app and checks native visibility/z-order when recovering.

## Build

The read-only helper at `native/taskbar-layout/TaskbarLayout.cs` queries Win32 and UI Automation geometry. It does not inject into Explorer, change taskbar settings, or move focus. The helper runs in a short-lived process with a timeout so an unresponsive accessibility provider cannot block the main process.

On Windows, run `pnpm run build:taskbar-helper` before development or direct packaging. It uses the .NET Framework C# compiler and WPF UI Automation assemblies supplied with Windows. `build`, `build:win`, and the release workflow already include this step. Other platforms skip compilation and do not ship the helper.

Preview cards use `@resvg/resvg-js` to produce a real PNG (Electron does not decode these SVG cards through `nativeImage`). Keep the native optional dependency in packaged builds; license information is in `THIRD_PARTY_NOTICES.md`.

## Verification

With Node 24 and installed dependencies:

```sh
node --test tests/taskbar-seek.test.mjs tests/taskbar-shell.test.mjs tests/taskbar-window.test.mjs tests/taskbar-dock.test.ts tests/taskbar-migration.test.mjs tests/window-bounds-persistence.test.ts tests/window-frame.test.mjs tests/window-rounded-shape.test.ts
pnpm exec vue-tsc --noEmit
pnpm exec vite build
pnpm run build:taskbar-helper
```

Tests cover geometry/DPI, isolated-window lifecycle and recovery, command routing, favorite state, real preview PNG generation, system theme selection and deferred seeking. They do not replace Windows desktop acceptance.

Manual checks before release: enable/disable/reopen, minimize/restore the main app, fullscreen recovery, transport/favorite/seek/lyric synchronization, detach/redock, and small/large taskbars with multiple monitors and different scale factors. Also verify crowded, vertical and auto-hidden fallback layouts and independent system/application theme choices. macOS/Linux should retain their existing behavior with no taskbar player window.
