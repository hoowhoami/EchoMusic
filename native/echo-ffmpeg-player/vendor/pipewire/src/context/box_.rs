// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{marker::PhantomData, ops::Deref, ptr};

use crate::{loop_::Loop, properties::PropertiesBox, Error};

use super::Context;

/// Smart pointer providing unique ownership of a PipeWire [context](super).
///
/// For shared ownership, see [`ContextRc`](super::ContextRc).
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug)]
pub struct ContextBox<'l> {
    ptr: std::ptr::NonNull<pw_sys::pw_context>,
    loop_: PhantomData<&'l Loop>,
}

impl<'l> ContextBox<'l> {
    pub fn new(
        loop_: &'l Loop,
        properties: Option<PropertiesBox>,
    ) -> Result<ContextBox<'l>, Error> {
        unsafe {
            let props = properties
                .map_or(ptr::null(), |props| props.into_raw())
                .cast_mut();
            let raw = ptr::NonNull::new(pw_sys::pw_context_new((*loop_).as_raw_ptr(), props, 0))
                .ok_or(Error::CreationFailed)?;

            Ok(Self::from_raw(raw))
        }
    }

    /// Create a `ContextBox` by taking ownership of a raw `pw_context`.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_context`](`pw_sys::pw_context`).
    ///
    /// The raw context must not be manually destroyed or moved, as the new [`ContextBox`] takes
    /// ownership of it.
    ///
    /// The lifetime of the returned box is unbounded. The caller is responsible to make sure
    /// that the loop used with this context outlives the context.
    pub unsafe fn from_raw(raw: std::ptr::NonNull<pw_sys::pw_context>) -> ContextBox<'l> {
        Self {
            ptr: raw,
            loop_: PhantomData,
        }
    }

    pub fn into_raw(self) -> std::ptr::NonNull<pw_sys::pw_context> {
        std::mem::ManuallyDrop::new(self).ptr
    }
}

impl<'l> std::ops::Deref for ContextBox<'l> {
    type Target = Context;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<Context>().as_ref() }
    }
}

impl<'l> AsRef<Context> for ContextBox<'l> {
    fn as_ref(&self) -> &Context {
        self.deref()
    }
}

impl<'l> std::ops::Drop for ContextBox<'l> {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_context_destroy(self.as_raw_ptr());
        }
    }
}
