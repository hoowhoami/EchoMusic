// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! The context manages all locally available resources.
//!
//! It can be used to connect to another PipeWire instance (the main daemon, for example) and interact with it.
//!
//! This module contains wrappers for [`pw_context`](pw_sys::pw_context) and related items.

use std::{
    os::fd::{IntoRawFd, OwnedFd},
    ptr,
};

use crate::{
    core::CoreBox,
    properties::{Properties, PropertiesBox},
    Error,
};

mod box_;
pub use box_::*;
mod rc;
pub use rc::*;

/// Transparent wrapper around a [context](self).
///
/// This does not own the underlying object and is usually seen behind a `&` reference.
///
/// For owning wrappers that can construct a context, see [`ContextBox`] and [`ContextRc`].
///
/// For an explanation of these, see [Smart pointers to PipeWire
/// objects](crate#smart-pointers-to-pipewire-objects).
#[repr(transparent)]
pub struct Context(pw_sys::pw_context);

impl Context {
    pub fn as_raw(&self) -> &pw_sys::pw_context {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_context {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn properties(&self) -> &Properties {
        unsafe {
            let props = pw_sys::pw_context_get_properties(self.as_raw_ptr());
            let props = ptr::NonNull::new(props.cast_mut()).expect("context properties is NULL");
            props.cast().as_ref()
        }
    }

    pub fn update_properties(&self, properties: &spa::utils::dict::DictRef) {
        unsafe {
            pw_sys::pw_context_update_properties(self.as_raw_ptr(), properties.as_raw_ptr());
        }
    }

    pub fn connect(&self, properties: Option<PropertiesBox>) -> Result<CoreBox<'_>, Error> {
        let properties = properties.map_or(ptr::null_mut(), |p| p.into_raw());

        unsafe {
            let core = pw_sys::pw_context_connect(self.as_raw_ptr(), properties, 0);
            let ptr = ptr::NonNull::new(core).ok_or(Error::CreationFailed)?;

            Ok(CoreBox::from_raw(ptr))
        }
    }

    pub fn connect_fd(
        &self,
        fd: OwnedFd,
        properties: Option<PropertiesBox>,
    ) -> Result<CoreBox<'_>, Error> {
        let properties = properties.map_or(ptr::null_mut(), |p| p.into_raw());

        unsafe {
            let raw_fd = fd.into_raw_fd();
            let core = pw_sys::pw_context_connect_fd(self.as_raw_ptr(), raw_fd, properties, 0);
            let ptr = ptr::NonNull::new(core).ok_or(Error::CreationFailed)?;

            Ok(CoreBox::from_raw(ptr))
        }
    }
}
