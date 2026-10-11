# Explorer restart and taskbar lyrics

## Confirmed crash in the supplied Windows report

`echo-taskbar-explorer-K6X3tz.zip` reproduced the crash in the isolated embedded
probe on Electron 43.7.6 / Windows 11 build 26100.4484, at 125% DPI. Its last
window message is lyric `WM_NCDESTROY` at `2026-10-11 19:19:15.150` (UTC+8).
There is no preceding `WM_DESTROY`, `WM_QUERYENDSESSION`, `WM_ENDSESSION`, or
`before-quit`. The supervisor recorded exit `2147483651` (`0x80000003`), and
Crashpad wrote a minidump. This is a native breakpoint crash, not the previously
suspected immediate exit with status zero.

The dump's Electron debug identifier matches the official 43.7.6 Windows x64
Breakpad symbols: `C6C9F79E876FC3B94C4C44205044422E1`. Symbolication gives:

```text
CrBrowserMain: EXCEPTION_BREAKPOINT, int 0x3
  observer destructor                 native_theme_observer.cc:13
  ~ElectronDesktopWindowTreeHostWin    electron_desktop_window_tree_host_win.cc:23
  DesktopNativeWidgetAura::OnHostClosed
  HWNDMessageHandler::OnWndProc
  gfx::WindowImpl::WndProc
```

The top function is displayed as `ui::AXModeObserver::~AXModeObserver()` because
the optimized binary folds identical functions; its line record identifies
`ui/native_theme/native_theme_observer.cc`. The host inherits
`ui::NativeThemeObserver`. Its destructor's
[`CHECK(!IsInObserverList())`](https://github.com/chromium/chromium/blob/150.0.7871.250/ui/native_theme/native_theme_observer.cc#L11-L13)
is the failing condition. Electron
[registers this observer at `WM_NCCREATE`, removes it only at `WM_DESTROY`, and has a default host destructor](https://github.com/electron/electron/blob/v43.7.6/shell/browser/ui/win/electron_desktop_window_tree_host_win.cc#L20-L43).
Chromium handles `WM_NCDESTROY` by closing and deleting the host. The observed
missing `WM_DESTROY` therefore leaves the observer registered during destruction.
The same missing phase also bypasses Chromium's compositor cleanup.

The reference's Electron 43.2.0 host has the same observer-registration/removal
logic; its Chromium 150.0.7871.129 observer destructor has the same CHECK. The
reference's JS `TaskbarCreated` reinitialization does not repair this C++
destruction sequence. There is no evidence here that downgrading Electron would
solve it or that the reference was tested through the same bare-NC teardown.

## Native lifecycle correction

`src/windows/taskbar/window_lifecycle.rs` installs a subclass from the NAPI
constructor on the lyric HWND's owning UI thread, before the layout worker can
embed it. It records whether `WM_DESTROY` was delivered. If `WM_NCDESTROY` arrives
alone, it synchronously delivers the missing `WM_DESTROY` through the complete
WndProc chain before allowing final destruction. The theme observer and
compositor can then clean up in their normal handlers. The existing `closed`
recovery recreates the destroyed lyric window and native session.

The correction does not cancel destruction, recursively call `DestroyWindow`,
or alter `WM_ENDSESSION`. Normal closing receives each destruction phase once.
State belongs to the HWND rather than the UIA session, survives a session stop,
and is removed at `WM_NCDESTROY`. Installation errors prevent unsafe embedding.
A Win32 regression test covers bare NC destruction, an already-delivered destroy
phase, real `DestroyWindow`, idempotent installation, and another subclass in
the same message chain. Its Windows-target compilation was checked on macOS;
the Win32 test and corrected application still need execution on Windows.

## Reference comparison and rejected shutdown hypothesis

SPlayer-Next's `onExplorerRestart()` in `electron/main/window/taskbarLyric.ts`
stops the layout watchers, calls `service.reinit()`, and creates new watchers.
Its separate `TaskbarCreatedWatcher` survives this transition. The Rust service
retains the lyric HWND and width, rebuilds the strategy, and re-embeds that HWND
if it is still valid. It does not recreate a BrowserWindow on this path.

EchoMusic handles `TaskbarCreated` in the layout worker itself. It drops the old
shell binding and reattaches; its `IUIAutomation` client survives the restart.
When the lyric HWND is destroyed, the worker exits. The main process's deferred
`closed` recovery then creates a new BrowserWindow and native session. This
recovery cannot run if Electron terminates the entire process before `closed`.
These lifecycle differences alone do not establish a crash cause.

SPlayer-Next declares Electron `~43.2.0` and locks `43.2.0` in `pnpm-lock.yaml`;
EchoMusic declares `43.7.6`. The installed reference runtime should also be
checked; a lockfile is not a measurement of the executable used for testing.

In [Electron 43.2.0](https://github.com/electron/electron/blob/v43.2.0/shell/browser/native_window_views_win.cc),
`WM_ENDSESSION` with a true `wParam` notifies the receiving window.
In [Electron 43.7.6](https://github.com/electron/electron/blob/v43.7.6/shell/browser/native_window_views_win.cc),
it notifies **all** windows and calls `TerminateCurrentProcessImmediately(0)`
unless the application already began quitting. The change is documented in
[Electron PR #52604](https://github.com/electron/electron/pull/52604).

Consequently, if the embedded lyric HWND receives `WM_ENDSESSION` during an
Explorer restart, 43.7.6 can exit the whole application without a JS exception
or a native crash. This is a candidate cause, not proof that Explorer actually
delivered that message in the reported run. The supplied diagnostic package
instead confirms the observer-destructor failure described above.
[Microsoft documents](https://learn.microsoft.com/en-us/windows/win32/rstmgr/guidelines-for-applications)
that Restart Manager uses `WM_QUERYENDSESSION` and `WM_ENDSESSION` with
`ENDSESSION_CLOSEAPP`. That does not by itself prove delivery to this foreign
embedded window. Do not suppress session messages or downgrade Electron based
only on this hypothesis: real shutdown, logoff, and application maintenance
must still work.

The supplied `echo-music-2026-10-11 (1).log` ends at `19:00:11.559`, with no
exception, renderer exit, or shutdown entry. EchoMusic's file transport writes
asynchronously, so absence of such entries cannot distinguish immediate process
termination from a native crash.

## Windows reproduction

Build the current Windows addon first. Run this from the repository root:

```powershell
node scripts/diagnose-taskbar-explorer.cjs --mode=embedded
```

Wait for the `ready` event in `events.jsonl` / visible probe lyric, then manually
restart **Windows Explorer** in Task Manager. If the probe survives, close its
main window to finish. The script creates an isolated temporary user-data
directory, does not load application settings, and does not restart Explorer
itself. A Node supervisor records the exit even when Electron cannot run its
exit handlers. Window messages are written synchronously, before Electron's
message processing. Local crash reports stay in `dumps`; uploading is disabled.

Repeat without native embedding to separate shell parenting from the runtime:

```powershell
node scripts/diagnose-taskbar-explorer.cjs --mode=unembedded
```

If both projects have Windows Electron executables installed, repeat the same
embedded probe with SPlayer-Next's executable via `--electron=<electron.exe>`.
Use the **same EchoMusic addon** to isolate the Electron-version difference.
The actual runtime version is recorded in the `start` event.

An optional controlled check sends `WM_ENDSESSION(TRUE, ENDSESSION_CLOSEAPP)`
only to the disposable lyric HWND, without ending the system session:

```powershell
node scripts/diagnose-taskbar-explorer.cjs --mode=embedded --inject-end-session
```

This injection tests Electron's response to a known message. It **does not**
prove that a real Explorer restart sends that message. The probe deliberately
does not cancel session events or recreate closed lyric windows.

Collect `events.jsonl`, `exit.json`, `stderr.log`, and any `dumps` from the printed
directory. Interpret them together:

| Evidence                                                                                                      | Meaning                                                                                              |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Real restart: lyric `WM_ENDSESSION`, `wParam=0x1`, session events on both windows, exit `0`, no `before-quit` | Matches the verified Electron immediate-termination path.                                            |
| `WM_DESTROY` / lyric `closed`, main survives                                                                  | Shell destroyed the host; window/session recovery is the relevant path.                              |
| Nonzero exception exit / crash dump without `WM_ENDSESSION`                                                   | Investigate the native/Chromium stack; the shutdown hypothesis is insufficient.                      |
| Probe survives but full EchoMusic fails                                                                       | Investigate application callbacks and other window integrations; this probe does not reproduce them. |

The original crash was reproduced on the user's Windows desktop and symbolicated
from the supplied dump on macOS. The corrected Windows addon must be rebuilt and
the real Explorer restart repeated; cross-target checks and mocked lifecycle
tests do not prove that the corrected Windows runtime survives.
