# Explorer restart and taskbar lyrics

## Verified differences

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
delivered that message in the reported run.
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

No real Windows reproduction has been run from the macOS workspace. Syntax checks
and mocked lifecycle tests do not establish the reported crash's root cause.
