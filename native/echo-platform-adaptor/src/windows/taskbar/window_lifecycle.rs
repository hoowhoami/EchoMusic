//! Preserve Electron's destruction contract when the foreign shell parent exits.
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::GetCurrentThreadId,
    UI::{
        Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{GetWindowThreadProcessId, SendMessageW, WM_DESTROY, WM_NCDESTROY},
    },
};

const SUBCLASS_ID: usize = 0x45434c59; // ECLY, separate from composition and DWM preview.
const DESTROY_RECEIVED: usize = 1;

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _: usize,
    state: usize,
) -> LRESULT {
    if message == WM_DESTROY {
        // State is per HWND, owned by comctl32; no JS or worker-session pointer.
        let _ = SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, DESTROY_RECEIVED);
    } else if message == WM_NCDESTROY {
        // Explorer teardown can deliver only WM_NCDESTROY to a foreign child.
        // Electron removes NativeThemeObserver in WM_DESTROY; Chromium also
        // destroys its compositor there, before OnHostClosed deletes the host.
        // Without this phase, NativeThemeObserver's destructor CHECKs and kills
        // the browser process. See docs/taskbar-explorer-investigation.md.
        if state != DESTROY_RECEIVED {
            // On this HWND's UI thread, SendMessage runs the whole WndProc chain
            // synchronously, with a separate subclass dispatch frame. Calling
            // DefSubclassProc twice would consume other subclasses' chain state.
            // Do not DestroyWindow again, or post cleanup after host deletion.
            let _ = SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, DESTROY_RECEIVED);
            SendMessageW(hwnd, WM_DESTROY, None, None);
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
        return Ok(());
    }
    if !SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS_ID, 0).as_bool() {
        return Err(napi::Error::from_reason(
            "Unable to install taskbar lyric window lifecycle",
        ));
    }
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
