//! Observe local clicks without consuming the native window-drag event.
use block2::RcBlock;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSEvent, NSEventMask, NSView};
use std::{cell::RefCell, ptr::NonNull};

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

#[napi(object)]
pub struct WindowPointerPosition {
    pub x: f64,
    pub y: f64,
}

#[napi]
pub fn stop_window_pointer_monitor() {
    MONITOR.with(|slot| {
        if let Some(token) = slot.borrow_mut().take() {
            unsafe { NSEvent::removeMonitor(&token) };
        }
    });
}

#[napi]
pub fn start_window_pointer_monitor(
    handle: Buffer,
    callback: ThreadsafeFunction<WindowPointerPosition>,
) -> napi::Result<()> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| napi::Error::from_reason("Window monitor requires the main thread"))?;
    let bytes: [u8; std::mem::size_of::<usize>()] = handle
        .as_ref()
        .try_into()
        .map_err(|_| napi::Error::from_reason("Invalid NSView handle"))?;
    // Electron supplies this NSView; the main process stops the monitor before window teardown.
    let view = unsafe { Retained::retain(usize::from_ne_bytes(bytes) as *mut NSView) }
        .ok_or_else(|| napi::Error::from_reason("Null NSView handle"))?;
    stop_window_pointer_monitor();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| {
        let event_ref = unsafe { event.as_ref() };
        if let (Some(window), Some(target)) = (event_ref.window(mtm), view.window()) {
            if std::ptr::eq(&*window, &*target) {
                let point = view.convertPoint_fromView(event_ref.locationInWindow(), None);
                let bounds = view.bounds();
                let y = if view.isFlipped() {
                    point.y - bounds.origin.y
                } else {
                    bounds.origin.y + bounds.size.height - point.y
                };
                callback.call(
                    Ok(WindowPointerPosition {
                        x: point.x - bounds.origin.x,
                        y,
                    }),
                    ThreadsafeFunctionCallMode::NonBlocking,
                );
            }
        }
        // Never suppress or replace the event: AppKit still handles click/drag/double-click.
        event.as_ptr()
    });
    let token = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown,
            &block,
        )
    }
    .ok_or_else(|| napi::Error::from_reason("Could not install window pointer monitor"))?;
    MONITOR.with(|slot| *slot.borrow_mut() = Some(token));
    Ok(())
}
