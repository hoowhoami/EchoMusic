// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{ops::Deref, ptr};

use super::Loop;
use crate::Error;

/// Smart pointer providing unique ownership of a PipeWire [loop](super).
///
/// For shared ownership, see [`LoopRc`](super::LoopRc).
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug)]
pub struct LoopBox {
    ptr: std::ptr::NonNull<pw_sys::pw_loop>,
}

impl LoopBox {
    /// Create a new [`LoopBox`].
    pub fn new(properties: Option<&spa::utils::dict::DictRef>) -> Result<Self, Error> {
        // This is a potential "entry point" to the library, so we need to ensure it is initialized.
        crate::init();

        unsafe {
            let props = properties
                .map_or(ptr::null(), |props| props.as_raw())
                .cast_mut();
            let raw = pw_sys::pw_loop_new(props);
            let ptr = ptr::NonNull::new(raw).ok_or(Error::CreationFailed)?;
            Ok(Self::from_raw(ptr))
        }
    }

    /// Create a new [`LoopBox`] from a raw [`pw_loop`](`pw_sys::pw_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_loop`](`pw_sys::pw_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`LoopBox`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_loop>) -> Self {
        Self { ptr }
    }

    pub fn into_raw(self) -> std::ptr::NonNull<pw_sys::pw_loop> {
        std::mem::ManuallyDrop::new(self).ptr
    }
}

impl std::ops::Deref for LoopBox {
    type Target = Loop;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<Loop>().as_ref() }
    }
}

impl AsRef<Loop> for LoopBox {
    fn as_ref(&self) -> &Loop {
        self.deref()
    }
}

// The owning type implements the Drop trait to clean up the raw type automatically.
impl std::ops::Drop for LoopBox {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_loop_destroy(self.as_raw_ptr());
        }
    }
}
