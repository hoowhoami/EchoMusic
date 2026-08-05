// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ffi::CStr,
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use crate::{
    error::Error,
    loop_::{IsLoopRc, Loop},
};

use super::{ThreadLoop, ThreadLoopBox};

#[derive(Debug)]
struct ThreadLoopRcInner {
    thread_loop: ThreadLoopBox,
}

#[derive(Debug, Clone)]
pub struct ThreadLoopRc {
    inner: Rc<ThreadLoopRcInner>,
}

impl ThreadLoopRc {
    /// Initialize Pipewire and create a new [`ThreadLoopRc`] with the given `name` and optional properties.
    ///
    /// # Safety
    /// TODO
    pub unsafe fn new(
        name: Option<&str>,
        properties: Option<&spa::utils::dict::DictRef>,
    ) -> Result<Self, Error> {
        let thread_loop = ThreadLoopBox::new(name, properties)?;

        Ok(Self::from_box(thread_loop))
    }

    /// Initialize Pipewire and create a new [`ThreadLoopRc`] with the given `name` as C string,
    /// and optional properties.
    ///
    /// # Safety
    /// TODO
    pub unsafe fn new_cstr(
        name: Option<&CStr>,
        properties: Option<&spa::utils::dict::DictRef>,
    ) -> Result<Self, Error> {
        let thread_loop = ThreadLoopBox::new_cstr(name, properties)?;

        Ok(Self::from_box(thread_loop))
    }

    /// Create a [`ThreadLoopRc`] using an existing [`ThreadLoopBox`].
    ///
    /// # Safety
    /// TODO
    pub unsafe fn from_box(thread_loop: ThreadLoopBox) -> Self {
        Self {
            inner: Rc::new(ThreadLoopRcInner { thread_loop }),
        }
    }

    /// Create a new main loop from a raw [`pw_thread_loop`](`pw_sys::pw_thread_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_thread_loop`](`pw_sys::pw_thread_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`ThreadLoopRc`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_thread_loop>) -> Self {
        let thread_loop = ThreadLoopBox::from_raw(ptr);

        Self {
            inner: Rc::new(ThreadLoopRcInner { thread_loop }),
        }
    }

    pub fn downgrade(&self) -> ThreadLoopWeak {
        let weak = Rc::downgrade(&self.inner);
        ThreadLoopWeak { weak }
    }
}

// Safety: The pw_loop is guaranteed to remain valid while any clone of the `ThreadLoopRc` is held,
//         because we use an internal Rc to keep the pw_thread_loop containing the pw_loop alive.
unsafe impl IsLoopRc for ThreadLoopRc {}

impl std::ops::Deref for ThreadLoopRc {
    type Target = ThreadLoop;

    fn deref(&self) -> &Self::Target {
        self.inner.thread_loop.deref()
    }
}

impl std::convert::AsRef<ThreadLoop> for ThreadLoopRc {
    fn as_ref(&self) -> &ThreadLoop {
        self.deref()
    }
}

impl std::convert::AsRef<Loop> for ThreadLoopRc {
    fn as_ref(&self) -> &Loop {
        self.loop_()
    }
}

pub struct ThreadLoopWeak {
    weak: Weak<ThreadLoopRcInner>,
}

impl ThreadLoopWeak {
    pub fn upgrade(&self) -> Option<ThreadLoopRc> {
        self.weak.upgrade().map(|inner| ThreadLoopRc { inner })
    }
}
