// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Wrapper that runs a [loop](crate::loop_) in the current thread.
//!
//! This module contains wrappers for [`pw_main_loop`](pw_sys::pw_main_loop) and related items.

use crate::loop_::Loop;

mod box_;
pub use box_::*;
mod rc;
pub use rc::*;

/// Transparent wrapper around a [main loop](self).
///
/// This does not own the underlying object and is usually seen behind a `&` reference.
///
/// For owning wrappers that can construct main loops, see [`MainLoopBox`] and [`MainLoopRc`].
///
/// For an explanation of these, see [Smart pointers to PipeWire
/// objects](crate#smart-pointers-to-pipewire-objects).
#[repr(transparent)]
pub struct MainLoop(pw_sys::pw_main_loop);

impl MainLoop {
    pub fn as_raw(&self) -> &pw_sys::pw_main_loop {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_main_loop {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn loop_(&self) -> &Loop {
        unsafe {
            let pw_loop = pw_sys::pw_main_loop_get_loop(self.as_raw_ptr());
            // FIXME: Make sure pw_loop is not null
            &*(pw_loop.cast::<Loop>())
        }
    }

    pub fn run(&self) {
        unsafe {
            pw_sys::pw_main_loop_run(self.as_raw_ptr());
        }
    }

    pub fn quit(&self) {
        unsafe {
            pw_sys::pw_main_loop_quit(self.as_raw_ptr());
        }
    }
}

impl std::convert::AsRef<Loop> for MainLoop {
    fn as_ref(&self) -> &Loop {
        self.loop_()
    }
}
