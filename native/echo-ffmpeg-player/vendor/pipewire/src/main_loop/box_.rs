// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{ops::Deref, ptr};

use crate::Error;

use super::MainLoop;

/// Smart pointer providing unique ownership of a PipeWire [main loop](super).
///
/// For shared ownership, see [`MainLoopRc`](super::MainLoopRc).
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug)]
pub struct MainLoopBox {
    ptr: std::ptr::NonNull<pw_sys::pw_main_loop>,
}

impl MainLoopBox {
    /// Initialize Pipewire and create a new [`MainLoopBox`]
    pub fn new(properties: Option<&spa::utils::dict::DictRef>) -> Result<Self, Error> {
        crate::init();

        unsafe {
            let props = properties
                .map_or(ptr::null(), |props| props.as_raw())
                .cast_mut();

            let raw = pw_sys::pw_main_loop_new(props);
            let ptr = ptr::NonNull::new(raw).ok_or(Error::CreationFailed)?;

            Ok(Self::from_raw(ptr))
        }
    }

    /// Create a new main loop from a raw [`pw_main_loop`](`pw_sys::pw_main_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_main_loop`](`pw_sys::pw_main_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`MainLoopBox`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_main_loop>) -> Self {
        Self { ptr }
    }

    pub fn into_raw(self) -> std::ptr::NonNull<pw_sys::pw_main_loop> {
        // Use ManuallyDrop to give up ownership of the managed struct and not run the destructor.
        std::mem::ManuallyDrop::new(self).ptr
    }
}

impl std::ops::Deref for MainLoopBox {
    type Target = MainLoop;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<MainLoop>().as_ref() }
    }
}

impl AsRef<MainLoop> for MainLoopBox {
    fn as_ref(&self) -> &MainLoop {
        self.deref()
    }
}

impl std::ops::Drop for MainLoopBox {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_main_loop_destroy(self.as_raw_ptr());
        }
    }
}
