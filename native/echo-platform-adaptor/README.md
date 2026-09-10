# echo-platform-adaptor

Windows desktop window integration. This addon owns HWND/DWM behavior; it has no
SMTC/MPRIS/Now Playing lifecycle or audio dependencies.

- `src/window_composition.rs`: optional Accent clear/BlurBehind compatibility backend.
- `src/taskbar.rs`: iconic thumbnail and Aero Peek cover previews, moved from
  `echo-media-controls` without changing their API or image processing.
- `src/main/native/platform.ts` in the application: shared loader and API validation.

## Build on Windows

```sh
cd native/echo-platform-adaptor
npm install
npm run build
```

This generates `echo-platform-adaptor.node` and `index.d.ts`. Restart the application
after rebuilding the addon. The Windows release job builds this module and
packages it as `resources/native/echo-platform-adaptor.node`. macOS and Linux do not
load or package it. `Cargo.lock` is committed for reproducible dependency resolution.

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


Windows 11 22H2+ clear backgrounds first prepare Electron's translucent compositor
through `setBackgroundMaterial('acrylic')`. Native mode 3 then sets only
`DWMWA_SYSTEMBACKDROP_TYPE` to `DWMSBT_NONE` before applying clear Accent and full
client margins. Calling Electron's `setBackgroundMaterial('none')` at that point
would mark its surface opaque again. Leaving clear mode resets both Electron's
material state and Accent; a mode-3 failure falls back to a solid surface. Rebuild
the addon with the application: earlier binaries reject mode 3 rather than
silently claiming success. Windows 10 / early Windows 11 retain the legacy path.


Windows 10 / early Windows 11 declare `backgroundMaterial: acrylic` **at window
creation** to let Electron 43 select an alpha-capable Chromium surface through
`IsTranslucent()` / `ShouldWindowContentsBeTransparent()`. The OS material setter
is a no-op on these versions; native clear/BlurBehind still comes from Accent.
Keep this declaration when switching effects off (draw an opaque themed surface
and disable Accent), so subsequent live switches retain alpha. Do not substitute
`transparent: true`, which disables Electron's thick frame. This compatibility
path depends on Electron internals and needs Windows regression testing on upgrades.
