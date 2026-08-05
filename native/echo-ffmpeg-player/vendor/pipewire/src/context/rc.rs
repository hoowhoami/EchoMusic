// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    fmt,
    ops::Deref,
    os::fd::{IntoRawFd, OwnedFd},
    ptr,
    rc::{Rc, Weak},
};

use crate::{
    core::CoreRc,
    loop_::{IsLoopRc, Loop},
    properties::PropertiesBox,
    Error,
};

use super::{Context, ContextBox};

struct ContextRcInner {
    context: ContextBox<'static>,
    // Store the loop here, so that the loop is not dropped before the context,
    // which may lead to undefined behaviour. Rusts drop order of struct fields
    // (from top to bottom) ensures that this is always destroyed _after_ the context.
    _loop: Box<dyn AsRef<Loop>>,
}

impl fmt::Debug for ContextRcInner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContextRcInner")
            .field("context", &self.context)
            .finish()
    }
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [context](super).
///
/// For the non-owning variant, see [`ContextWeak`]. For unique ownership, see [`ContextBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Clone, Debug)]
pub struct ContextRc {
    inner: Rc<ContextRcInner>,
}

impl ContextRc {
    pub fn new<T: IsLoopRc>(loop_: &T, properties: Option<PropertiesBox>) -> Result<Self, Error> {
        let loop_: Box<dyn AsRef<Loop>> = Box::new(loop_.clone());
        let props = properties
            .map_or(ptr::null(), |props| props.into_raw())
            .cast_mut();

        unsafe {
            let raw = ptr::NonNull::new(pw_sys::pw_context_new(
                (*loop_).as_ref().as_raw_ptr(),
                props,
                0,
            ))
            .ok_or(Error::CreationFailed)?;

            let context: ContextBox<'static> = ContextBox::from_raw(raw);

            Ok(ContextRc {
                inner: Rc::new(ContextRcInner {
                    context,
                    _loop: loop_,
                }),
            })
        }
    }

    // TODO: from_raw()

    pub fn downgrade(&self) -> ContextWeak {
        let weak = Rc::downgrade(&self.inner);
        ContextWeak { weak }
    }

    pub fn connect_rc(&self, properties: Option<PropertiesBox>) -> Result<CoreRc, Error> {
        let properties = properties.map_or(ptr::null_mut(), |p| p.into_raw());

        unsafe {
            let core = pw_sys::pw_context_connect(self.as_raw_ptr(), properties, 0);
            let ptr = ptr::NonNull::new(core).ok_or(Error::CreationFailed)?;

            Ok(CoreRc::from_raw(ptr, self.clone()))
        }
    }

    pub fn connect_fd_rc(
        &self,
        fd: OwnedFd,
        properties: Option<PropertiesBox>,
    ) -> Result<CoreRc, Error> {
        let properties = properties.map_or(ptr::null_mut(), |p| p.into_raw());

        unsafe {
            let raw_fd = fd.into_raw_fd();
            let core = pw_sys::pw_context_connect_fd(self.as_raw_ptr(), raw_fd, properties, 0);
            let ptr = ptr::NonNull::new(core).ok_or(Error::CreationFailed)?;

            Ok(CoreRc::from_raw(ptr, self.clone()))
        }
    }
}

impl std::ops::Deref for ContextRc {
    type Target = Context;

    fn deref(&self) -> &Self::Target {
        self.inner.context.deref()
    }
}

impl std::convert::AsRef<Context> for ContextRc {
    fn as_ref(&self) -> &Context {
        self.deref()
    }
}

/// Non-owning reference to a [context](super) managed by [`ContextRc`].
///
/// The context can be accessed by calling [`upgrade`](Self::upgrade).
pub struct ContextWeak {
    weak: Weak<ContextRcInner>,
}

impl ContextWeak {
    pub fn upgrade(&self) -> Option<ContextRc> {
        self.weak.upgrade().map(|inner| ContextRc { inner })
    }
}
