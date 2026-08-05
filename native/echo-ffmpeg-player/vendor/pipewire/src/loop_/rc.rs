// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use super::{Loop, LoopBox};
use crate::Error;

/// Trait implemented by objects that implement a `pw_loop` and are reference counted in some way.
///
/// # Safety
///
/// The [`Loop`] returned by the implementation of `AsRef<Loop>` must remain valid as long as any clone
/// of the trait implementor is still alive.
pub unsafe trait IsLoopRc: Clone + AsRef<Loop> + 'static {}

#[derive(Debug)]
struct LoopRcInner {
    loop_: LoopBox,
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [loop](super).
///
/// For the non-owning variant, see [`LoopWeak`].
/// For unique ownership, see [`LoopBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Clone, Debug)]
pub struct LoopRc {
    inner: Rc<LoopRcInner>,
}

impl LoopRc {
    /// Create a new [`LoopRc`].
    pub fn new(properties: Option<&spa::utils::dict::DictRef>) -> Result<Self, Error> {
        let loop_ = LoopBox::new(properties)?;

        Ok(Self {
            inner: Rc::new(LoopRcInner { loop_ }),
        })
    }

    /// Create a new [`LoopRc`] from a raw [`pw_loop`](`pw_sys::pw_loop`), taking ownership of it.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_loop`](`pw_sys::pw_loop`).
    ///
    /// The raw loop should not be manually destroyed or moved, as the new [`LoopRc`] takes ownership of it.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_loop>) -> Self {
        let loop_ = LoopBox::from_raw(ptr);

        Self {
            inner: Rc::new(LoopRcInner { loop_ }),
        }
    }

    pub fn downgrade(&self) -> LoopWeak {
        let weak = Rc::downgrade(&self.inner);
        LoopWeak { weak }
    }
}

// Safety: The inner pw_loop is guaranteed to remain valid while any clone of the `LoopRc` is held,
//         because we use an internal Rc to keep it alive.
unsafe impl IsLoopRc for LoopRc {}

impl Deref for LoopRc {
    type Target = Loop;

    fn deref(&self) -> &Self::Target {
        self.inner.loop_.deref()
    }
}

impl std::convert::AsRef<Loop> for LoopRc {
    fn as_ref(&self) -> &Loop {
        self.deref()
    }
}

/// Non-owning reference to a [loop](super) managed by [`LoopRc`].
///
/// The loop can be accessed by calling [`upgrade`](Self::upgrade).
pub struct LoopWeak {
    weak: Weak<LoopRcInner>,
}

impl LoopWeak {
    pub fn upgrade(&self) -> Option<LoopRc> {
        self.weak.upgrade().map(|inner| LoopRc { inner })
    }
}
