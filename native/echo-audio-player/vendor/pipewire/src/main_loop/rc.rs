// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use crate::{
    loop_::{IsLoopRc, Loop},
    Error,
};

use super::{MainLoop, MainLoopBox};

#[derive(Debug)]
struct MainLoopRcInner {
    main_loop: MainLoopBox,
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [main loop](super).
///
/// For the non-owning variant, see [`MainLoopWeak`].
/// For unique ownership, see [`MainLoopBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug, Clone)]
pub struct MainLoopRc {
    inner: Rc<MainLoopRcInner>,
}

impl MainLoopRc {
    /// Initialize Pipewire and create a new [`MainLoopRc`]
    pub fn new(properties: Option<&spa::utils::dict::DictRef>) -> Result<Self, Error> {
        let main_loop = MainLoopBox::new(properties)?;

        Ok(Self {
            inner: Rc::new(MainLoopRcInner { main_loop }),
        })
    }

    /// Create a new main loop from a raw [`pw_main_loop`](`pw_sys::pw_main_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_main_loop`](`pw_sys::pw_main_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`MainLoopRc`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_main_loop>) -> Self {
        let main_loop = MainLoopBox::from_raw(ptr);

        Self {
            inner: Rc::new(MainLoopRcInner { main_loop }),
        }
    }

    pub fn downgrade(&self) -> MainLoopWeak {
        let weak = Rc::downgrade(&self.inner);
        MainLoopWeak { weak }
    }
}

// Safety: The pw_loop is guaranteed to remain valid while any clone of the `MainLoop` is held,
//         because we use an internal Rc to keep the pw_main_loop containing the pw_loop alive.
unsafe impl IsLoopRc for MainLoopRc {}

impl std::ops::Deref for MainLoopRc {
    type Target = MainLoop;

    fn deref(&self) -> &Self::Target {
        self.inner.main_loop.deref()
    }
}

impl std::convert::AsRef<MainLoop> for MainLoopRc {
    fn as_ref(&self) -> &MainLoop {
        self.deref()
    }
}

impl std::convert::AsRef<Loop> for MainLoopRc {
    fn as_ref(&self) -> &Loop {
        self.loop_()
    }
}

/// Non-owning reference to a [main loop](super) managed by [`MainLoopRc`].
///
/// The main loop can be accessed by calling [`upgrade`](Self::upgrade).
pub struct MainLoopWeak {
    weak: Weak<MainLoopRcInner>,
}

impl MainLoopWeak {
    pub fn upgrade(&self) -> Option<MainLoopRc> {
        self.weak.upgrade().map(|inner| MainLoopRc { inner })
    }
}
