//! Preserve Electron's destruction contract when the foreign shell parent exits.
use std::sync::atomic::{AtomicU32, Ordering};
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            GetWindowThreadProcessId, SendMessageW, WM_DESTROY, WM_GETOBJECT, WM_NCDESTROY,
        },
    },
};

const SUBCLASS_ID: usize = 0x45434c59; // ECLY, separate from composition and DWM preview.
const DESTROY_RECEIVED: usize = 1;

/// Thread that installed the subclass. Only one lyric window is embedded at a
/// time, so a single slot is enough; it lets the subclass refuse to synthesize
/// messages once the window has been adopted by another thread.
static INSTALL_THREAD: AtomicU32 = AtomicU32::new(0);

fn install_thread_id() -> u32 {
    INSTALL_THREAD.load(Ordering::Acquire)
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    state: usize,
) -> LRESULT {
    // Explorer 的 UIA 遍历任务栏时会枚举到本窗口并发 WM_GETOBJECT，跨进程进入
    // Chromium 的无障碍实现。实测（WER AppHangXProcB1，P6=electron.exe）：
    // explorer 因此被挂起等待本进程，触发无响应判定并重启。
    //
    // 这条拦截**不是** hover 失效的原因 —— hover 失效的真凶是 attach() 缺
    // WS_EX_LAYERED 且顺序反了（先样式后 SetParent），修好之后二者可以共存。
    // 返回 0 表示「本窗口无可访问对象」，UIA 会跳过我们，调用立即返回、不阻塞。
    // 做法参考 AF-Media-Bar 的 TaskbarHostMessagePolicy.ShouldSuppressPropagation。
    if message == WM_GETOBJECT {
        return LRESULT(0);
    }

    if message == WM_DESTROY {
        // State is per HWND, owned by comctl32; no JS or worker-session pointer.
        let _ = SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, DESTROY_RECEIVED);
    } else if message == WM_NCDESTROY {
        // A missing WM_DESTROY makes Electron's NativeThemeObserver destructor CHECK
        // and kills the browser process. See docs/taskbar-explorer-investigation.md.
        if state != DESTROY_RECEIVED {
            let _ = SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, DESTROY_RECEIVED);
            // Only synthesize it while this HWND still lives on the thread that
            // installed the subclass. SendMessage runs the whole WndProc chain
            // synchronously, so if the window has been reparented to another
            // process's UI thread this would execute Chromium's window host on a
            // foreign thread -- deadlocking both processes and taking down the
            // shell. Skip rather than hang the owner of the thread we are on.
            if GetWindowThreadProcessId(hwnd, None) == install_thread_id() {
                SendMessageW(hwnd, WM_DESTROY, None, None);
            }
        }
        let _ = RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID);
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

/// Must run on the HWND's UI thread before SetParent. Lives until WM_NCDESTROY,
/// even if a layout session is stopped before Electron destroys its window.
pub(super) unsafe fn install(hwnd: HWND) -> napi::Result<()> {
    if GetWindowThreadProcessId(hwnd, None) != GetCurrentThreadId() {
        return Err(napi::Error::from_reason(
            "Taskbar lyric lifecycle must be installed on the window's UI thread",
        ));
    }
    let mut state = 0;
    if GetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, Some(&mut state)).as_bool() {
        INSTALL_THREAD.store(GetCurrentThreadId(), Ordering::Release);
        return Ok(());
    }
    if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0).as_bool() {
        return Err(napi::Error::from_reason(
            "Unable to install taskbar lyric window lifecycle",
        ));
    }
    INSTALL_THREAD.store(GetCurrentThreadId(), Ordering::Release);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use windows::{
        core::w,
        Win32::{
            System::LibraryLoader::GetModuleHandleW,
            UI::WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassW, UnregisterClassW,
                WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSW,
            },
        },
    };

    thread_local! {
        static MESSAGES: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
        static OTHER_MESSAGES: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    }

    unsafe extern "system" fn other_subclass(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        _: usize,
    ) -> LRESULT {
        if matches!(message, WM_DESTROY | WM_NCDESTROY) {
            OTHER_MESSAGES.with(|messages| messages.borrow_mut().push(message));
        }
        if message == WM_NCDESTROY {
            let _ = RemoveWindowSubclass(hwnd, Some(other_subclass), id);
        }
        DefSubclassProc(hwnd, message, wparam, lparam)
    }

    unsafe extern "system" fn receiver(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if matches!(message, WM_DESTROY | WM_NCDESTROY) {
            MESSAGES.with(|messages| messages.borrow_mut().push(message));
            // Keep this test HWND alive until DestroyWindow at the end.
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    #[test]
    fn win32_subclass_orders_destroy_before_nc_destroy_without_duplicates() {
        unsafe {
            let instance = GetModuleHandleW(None).unwrap();
            let class = WNDCLASSW {
                lpfnWndProc: Some(receiver),
                lpszClassName: w!("EchoTaskbarLifecycleTest"),
                hInstance: instance.into(),
                ..Default::default()
            };
            assert_ne!(RegisterClassW(&class), 0);
            for (received_destroy, destroy_window) in [(false, false), (true, false), (false, true)]
            {
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class.lpszClassName,
                    w!(""),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    None,
                    None,
                    Some(instance.into()),
                    None,
                )
                .unwrap();
                assert!(SetWindowSubclass(hwnd, Some(other_subclass), 42, 0).as_bool());
                install(hwnd).unwrap();
                install(hwnd).unwrap(); // A restarted session must preserve HWND state.
                MESSAGES.with(|messages| messages.borrow_mut().clear());
                OTHER_MESSAGES.with(|messages| messages.borrow_mut().clear());
                if received_destroy {
                    SendMessageW(hwnd, WM_DESTROY, None, None);
                    install(hwnd).unwrap();
                }
                if destroy_window {
                    DestroyWindow(hwnd).unwrap();
                } else {
                    SendMessageW(hwnd, WM_NCDESTROY, None, None);
                }
                MESSAGES.with(|messages| {
                    assert_eq!(*messages.borrow(), vec![WM_DESTROY, WM_NCDESTROY]);
                });
                OTHER_MESSAGES.with(|messages| {
                    assert_eq!(*messages.borrow(), vec![WM_DESTROY, WM_NCDESTROY]);
                });
                let mut state = 0;
                assert!(
                    !GetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, Some(&mut state))
                        .as_bool()
                );
                if !destroy_window {
                    DestroyWindow(hwnd).unwrap();
                }
            }
            UnregisterClassW(class.lpszClassName, Some(instance.into())).unwrap();
        }
    }
}
