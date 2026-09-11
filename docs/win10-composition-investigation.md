# Windows 10 background investigation

## Confirmed failure

EchoMusic 2.3.2-beta.3 / Electron 43.6.0 / Windows 10 19045 still fails to
display both clear and BlurBehind backgrounds in a user report. Renderer backgrounds
are transparent, the clear tint opacity is zero, GPU composition is enabled, and
both `legacyFrameRepairInstalled` and `legacyFrameRepairLastSucceeded` are true.
This disproves frame repair as a sufficient fix. Do not describe this release's
Windows 10 background effects as visually verified.

`nativeWindowBackground: "#000000"` is not evidence of an opaque alpha channel:
Electron's `BaseWindow::GetBackgroundColor` serializes RGB only.

## Source-level discrepancy, not yet a verified fix

In Electron [43.6.0 NativeWindowViews](https://github.com/electron/electron/blob/v43.6.0/shell/browser/native_window_views.cc),
Widget initialization selects `kTranslucent` for `transparent() || has_client_frame()`.
The Windows client-frame path is unavailable, and the failing beta.3 window used `transparent: false`.
Declaring `backgroundMaterial: acrylic` influences `IsTranslucent()` but does not
satisfy that Widget initialization condition. On Windows before 11 22H2,
`SetBackgroundMaterial` returns before `SetIsTranslucent` and
`UpdateWindowTransparency`. HWND margin/Accent calls cannot themselves call those
Chromium methods. This is a candidate explanation for alpha output failures; it
does not establish that Accent Acrylic requires the same initialization. It still
needs a Windows experiment, not another assertion based on API success.

## Public implementations and runtime change

[Vibrancy Continued](https://github.com/illixion/vscode-vibrancy-continued/blob/08068850c9bf4b8af0ebf7223364ce2016bc5b22/runtime/index.mjs)
uses legacy Accent Acrylic for Win10 frost, keeping an opaque Electron window on
current releases to retain snapping/maximize/resize. Its
[drag handling](https://github.com/illixion/vscode-vibrancy-continued/blob/08068850c9bf4b8af0ebf7223364ce2016bc5b22/runtime/win-acrylic-drag.mjs)
temporarily disables Acrylic. Its
[window configuration](https://github.com/illixion/vscode-vibrancy-continued/blob/08068850c9bf4b8af0ebf7223364ce2016bc5b22/extension/file-transforms.js)
explicitly treats pure transparency differently, selecting `transparent: true`.
This is a third-party VS Code extension, not VS Code's built-in implementation.

The working-tree change now uses native protocol 8 for Win10/early Win11 frost,
with native modal-loop drag suppression instead of the extension's JS debounce.
It uses the minimum nonzero Acrylic tint alpha from
[Tauri window-vibrancy](https://github.com/tauri-apps/window-vibrancy/blob/dev/src/windows.rs).
Our addon does not change HWND styles. Clear now uses Electron's `transparent: true`
creation option without `backgroundMaterial` or native DWM clear calls. The user
accepted the native frame/animation limitations. Entering or leaving clear requires
restart; pending incompatible effects fall back to solid instead of reporting
success. Off/frost remain nontransparent Electron windows. Both implementations
still require Windows 10 visual validation.

## Controlled reproduction

Use a Windows build of the current native addon (protocols 6, 7 and 8). From the repo:

```powershell
pnpm exec electron scripts/repro-win10-composition.cjs
```

To use the addon from an installed release:

```powershell
pnpm exec electron scripts/repro-win10-composition.cjs --addon="C:\path\to\resources\native\echo-platform-adaptor.node"
```

The experiment does not start EchoMusic or read/write its settings. It creates two
windows with minimal transparent HTML. A is the old opaque material-bootstrap
configuration; B is the new Electron transparent clear configuration (no material).
Electron disables `thickFrame` for B. Press 0 (solid), 1 (Electron clear), 2 (new
Acrylic), 3 (old BlurBehind) or 4 (old DWM clear). Both start with Electron clear;
A is expected to remain opaque in that case. For the production frost configuration,
use Acrylic on A. Place a patterned window behind them and record visible results
separately from console API results. Test moving, resizing and minimize/restore.

- A fails, B works: narrows the problem to the Electron transparency/frame paths;
  it does not prove which individual Chromium flag is responsible.
- Both fail: investigate the native backend/OS/GPU path as well. Do not assume
  changing Widget opacity will fix it.
- Clear works but blur fails: investigate Accent separately from alpha output.

No custom Electron build is used. Preserve the reported working Windows 11 mode 5.
