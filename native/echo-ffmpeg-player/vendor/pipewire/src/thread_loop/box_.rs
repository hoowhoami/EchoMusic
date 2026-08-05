// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ffi::{CStr, CString},
    ops::Deref,
    ptr,
};

use crate::Error;

use super::ThreadLoop;

#[derive(Debug)]
pub struct ThreadLoopBox {
    ptr: ptr::NonNull<pw_sys::pw_thread_loop>,
}

impl ThreadLoopBox {
    /// Initialize Pipewire and create a new [`ThreadLoopBox`] with the given `name` and optional properties.
    ///
    /// # Safety
    /// TODO
    pub unsafe fn new(
        name: Option<&str>,
        properties: Option<&spa::utils::dict::DictRef>,
    ) -> Result<Self, Error> {
        let name = name.map(|name| CString::new(name).unwrap());

        ThreadLoopBox::new_cstr(name.as_deref(), properties)
    }

    /// Initialize Pipewire and create a new [`ThreadLoopBox`] with the given `name` as a C string,
    /// and optional properties.
    ///
    /// # Safety
    /// TODO
    pub unsafe fn new_cstr(
        name: Option<&CStr>,
        properties: Option<&spa::utils::dict::DictRef>,
    ) -> Result<Self, Error> {
        crate::init();

        unsafe {
            let props = properties.map_or(ptr::null(), |props| props.as_raw_ptr());
            let name = name.map_or(ptr::null(), |p| p.as_ptr() as *const _);

            let raw = pw_sys::pw_thread_loop_new(name, props);
            let ptr = ptr::NonNull::new(raw).ok_or(Error::CreationFailed)?;

            Ok(Self::from_raw(ptr))
        }
    }

    /// Create a new thread loop from a raw [`pw_thread_loop`](`pw_sys::pw_thread_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_thread_loop`](`pw_sys::pw_thread_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`ThreadLoopBox`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_thread_loop>) -> Self {
        Self { ptr }
    }

    pub fn into_raw(self) -> std::ptr::NonNull<pw_sys::pw_thread_loop> {
        // Use ManuallyDrop to give up ownership of the managed struct and not run the destructor.
        std::mem::ManuallyDrop::new(self).ptr
    }
}

impl std::ops::Deref for ThreadLoopBox {
    type Target = ThreadLoop;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<ThreadLoop>().as_ref() }
    }
}

impl AsRef<ThreadLoop> for ThreadLoopBox {
    fn as_ref(&self) -> &ThreadLoop {
        self.deref()
    }
}

impl std::ops::Drop for ThreadLoopBox {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_thread_loop_destroy(self.as_raw_ptr());
        }
    }
}
