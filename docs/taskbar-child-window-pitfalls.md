# Taskbar child window: two confirmed pitfalls and one open issue

This documents findings from embedding the taskbar lyric window as a child of
`Shell_TrayWnd` on Electron 43.7.6 / Windows 11 build 26100.4484. They extend
`taskbar-explorer-investigation.md`, which covers the destruction-order crash.
Companion repro: commit series starting at `9b30cf43` plus `d9ab882e`.

## 1. Missing `WS_EX_LAYERED` silently kills all mouse input

With the lyric window reparented into the taskbar, the renderer received no
mouse events at all: no `mouseenter`, no hover, no clicks. The window still
painted correctly, which makes this easy to misdiagnose.

Measured state when input was dead:

| Probe | Result |
| --- | --- |
| `GetWindowThreadProcessId` | Electron's own UI thread, not explorer's |
| `ChildWindowFromPointEx(tray, pt, CWP_SKIPTRANSPARENT)` | hits `Chrome_WidgetWin_1` (our window) |
| `GetCapture()` | `NULL` — explorer is not holding capture |
| Renderer | received nothing |

So the OS delivered the mouse to the right window and nothing was stealing it:
Chromium accepted `WM_MOUSEMOVE` and never forwarded it to the renderer.

The cause was a missing `WS_EX_LAYERED`. A layered window gets its own input and
composition surface; without it, Chromium's `HWNDMessageHandler` does not route
mouse messages into the renderer for a window whose parent belongs to another
process. Adding it restored hover and clicks immediately.

### Ordering matters as well

`WS_EX_LAYERED` must be applied **after** `SetParent`. Applying styles first and
reparenting second was the failing order; reparenting first and then adding the
extended styles works. Both orders were tested, only the latter forwards input.

## 2. `WM_GETOBJECT` from explorer's UIA hangs explorer

Letting explorer's UI Automation traversal reach Chromium's accessibility
implementation across the process boundary hangs explorer. Windows Error
Reporting recorded it as a cross-process hang with the blocking process named
explicitly:

```text
Event name: AppHangXProcB1
P1: explorer.exe          <- hung process
P6: electron.exe          <- blocking process
P7: 43.7.6.0
```

The sequence is: explorer's UIA walks the taskbar, enumerates the lyric child,
sends `WM_GETOBJECT`, and blocks waiting for our process while our process is
busy on its own side. Windows declares the taskbar unresponsive and restarts it.

Suppressing the message is enough — return `0` ("no accessible object") without
calling `DefSubclassProc`, so UIA skips the window and the call returns
immediately. The lyric does not need to expose accessibility to the taskbar.
The same technique appears in AF-Media-Bar's
`TaskbarHostMessagePolicy.ShouldSuppressPropagation`.

Note the interaction between the two fixes: suppressing `WM_GETOBJECT` was once
suspected of causing the dead input in pitfall 1 and removed. That was wrong —
the real cause was the missing `WS_EX_LAYERED`. Both changes are needed
together; neither substitutes for the other.

## 3. Open issue: position jitter on tray expand/collapse

Clicking the tray "show hidden icons" chevron makes the lyric window jump by
3-12 physical pixels and snap back, repeatedly, for as long as the interaction
continues. Instrumentation run on a 40 ms sampler over all `Shell_TrayWnd`
children:

- Only the lyric window and its two Chromium children
  (`Chrome_RenderWidgetHostHWND`, `Intermediate D3D Window`) move, and they move
  in lockstep.
- `TrayNotifyWnd`, `DesktopWindowContentBridge`, `Start` and `ReBarWindow32`
  never move, so this is not the taskbar's own layout animation.
- The application never issues a reposition: the layout callback does not fire
  and `setBounds` is not called. The mover and the restorer are both outside
  our code.
- The excursions are discrete snaps, not animation frames, and always return to
  exactly the same x.
- Converting the window to a real `WS_CHILD` did not change the behaviour, so it
  is not simply a popup child being nudged.

Working hypothesis: Chromium's `HWNDMessageHandler` reacts to
`WM_WINDOWPOSCHANGING` for a window it believes is top-level while the real
parent is foreign, and corrects the position against its own tracked bounds.
The likely fix is to stop routing window positioning through Electron and
instead position from native code, rejecting moves in `WM_WINDOWPOSCHANGING`
that the application did not initiate. That means taking ownership of
positioning away from `BrowserWindow.setBounds`, which is a larger change than
the two fixes above and was deferred.
