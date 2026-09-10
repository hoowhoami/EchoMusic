# echo-platform-adaptor

Windows and macOS desktop window integration. This addon owns HWND/DWM behavior and
local AppKit mouse observation; it has no
SMTC/MPRIS/Now Playing lifecycle or audio dependencies.

- `src/window_composition.rs`: DWM alpha clear and optional Accent BlurBehind backends.
- `src/taskbar.rs`: iconic thumbnail and Aero Peek cover previews, moved from
  `echo-media-controls` without changing their API or image processing.
- `src/main/native/platform.ts` in the application: shared loader and API validation.
- `src/window_pointer.rs`: macOS local mouse-down monitor for the main window. It
  returns every event unchanged so native dragging and double-click behavior remain
  intact. It does not observe other applications or require Accessibility permission.

## Build on Windows or macOS

```sh
cd native/echo-platform-adaptor
npm install
npm run build
```

This generates `echo-platform-adaptor.node` and `index.d.ts`. Restart the application
after rebuilding the addon. Windows and macOS release jobs build and package it
as `resources/native/echo-platform-adaptor.node`. Linux does not load or package it.
`Cargo.lock` is committed for reproducible dependency resolution.

Cross-target type checking from a machine with the Windows Rust target installed:

```sh
cargo check --manifest-path native/echo-platform-adaptor/Cargo.toml --target x86_64-pc-windows-msvc --locked
```

## Ownership and fallback

Only the main process calls this addon, synchronously on the HWND's UI thread.
No window handles or Accent state values are accepted directly from a renderer.
Media controls remain in `echo-media-controls`; enabling/disabling media controls
does not initialize or tear down this addon.

`SetWindowCompositionAttribute` is dynamically resolved and its Accent policy is
undocumented. Windows 10 BlurBehind avoids Acrylic's interactive-resize stalls.
Windows 11 22H2+ Acrylic uses Electron's official `setBackgroundMaterial` instead.
An unavailable DLL export, invalid HWND, or failed native operation returns false;
the application displays a solid background and a status message. OS policy,
graphics drivers and remote sessions can affect visible results even after a
successful API call. Do not emulate corners using `SetWindowRgn` or add layered
window styles; those would defeat the native window frame.


## Clear composition

Clear backgrounds explicitly enable DWM alpha composition through
`DwmEnableBlurBehindWindow` with `DWM_BB_ENABLE | DWM_BB_BLURREGION`, following the
[GLFW/ImGui alpha-compositing approach](https://github.com/ocornut/imgui/blob/master/backends/imgui_impl_win32.cpp).
[Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/nf-dwmapi-dwmenableblurbehindwindow)
that this honors per-pixel alpha and does not produce blur on Windows 8+.
The temporary GDI region is released immediately; it is not an HWND shape and
is never passed to `SetWindowRgn`. Clear disables Accent instead of requesting
`ACCENT_ENABLE_TRANSPARENTGRADIENT`, which did not produce visible transparency
in the reported Windows 11 24H2 environment.

Windows 11 22H2+ first prepares Electron's translucent compositor using
`setBackgroundMaterial('acrylic')`. Native mode 5 removes only the DWM system
backdrop and then enables DWM alpha. Calling Electron's material setter with
`none` at this point would make its surface opaque again. Exiting clear resets
both Electron and native states; failures attempt to disable alpha, Accent and
client margins before the application restores its solid background.

Windows 10 / early Windows 11 declare `backgroundMaterial: acrylic` at creation
for Electron's alpha surface, then use native mode 4 for DWM alpha. Actual blur
still uses Accent mode 2. The native material setter is a no-op on these OS
versions. Keep the constructor declaration across off/clear/blur switches.

Modes 4/5 replace the retired Accent-clear protocol 1/3. Rebuild and package the
addon with the application: older binaries reject the new modes and trigger an
explicit fallback. This change needs Windows visual validation; successful API
calls and state tests alone do not establish correct desktop transparency.

## Diagnosing transparent-background failures

In Windows Appearance settings, choose `复制窗口诊断信息` after reproducing the
problem with a nonzero transparency value. The report separates the accepted
backend request from readback of Accent, DWM backdrop, composition availability,
layered/no-redirection styles and remote-session state. It also records Electron,
OS and application versions, GPU feature status and renderer background layers.
No window screenshot or unrelated application content is collected. A successful
readback still does not establish visible transparency; compare with the actual
window. Older addons remain loadable and report native diagnostics unavailable.
