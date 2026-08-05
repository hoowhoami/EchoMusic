// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use spa::spa_interface_call_method;

use crate::{registry::RegistryRc, Error};

use super::{Core, CoreBox};

#[derive(Debug)]
struct CoreRcInner {
    core: CoreBox<'static>,
    // Store the context here, so that the context is not dropped before the core,
    // which may lead to undefined behaviour. Rusts drop order of struct fields
    // (from top to bottom) ensures that this is always destroyed _after_ the core.
    _context: crate::context::ContextRc,
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [core](super).
///
/// For the non-owning variant, see [`CoreWeak`].
/// For unique ownership, see [`CoreBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug, Clone)]
pub struct CoreRc {
    inner: Rc<CoreRcInner>,
}

impl CoreRc {
    pub fn from_raw(
        ptr: ptr::NonNull<pw_sys::pw_core>,
        context: crate::context::ContextRc,
    ) -> Self {
        let core = unsafe { CoreBox::from_raw(ptr) };

        Self {
            inner: Rc::new(CoreRcInner {
                core,
                _context: context,
            }),
        }
    }

    pub fn downgrade(&self) -> CoreWeak {
        let weak = Rc::downgrade(&self.inner);
        CoreWeak { weak }
    }

    pub fn get_registry_rc(&self) -> Result<RegistryRc, Error> {
        unsafe {
            let registry = spa_interface_call_method!(
                self.as_raw_ptr(),
                pw_sys::pw_core_methods,
                get_registry,
                pw_sys::PW_VERSION_REGISTRY,
                0
            );
            let registry = ptr::NonNull::new(registry).ok_or(Error::CreationFailed)?;
            Ok(RegistryRc::from_raw(registry, self.clone()))
        }
    }
}

impl Deref for CoreRc {
    type Target = Core;

    fn deref(&self) -> &Self::Target {
        self.inner.core.deref()
    }
}

impl AsRef<Core> for CoreRc {
    fn as_ref(&self) -> &Core {
        self.deref()
    }
}

/// Non-owning reference to a [core](super) managed by [`CoreRc`].
///
/// The core can be accessed by calling [`upgrade`](Self::upgrade).
pub struct CoreWeak {
    weak: Weak<CoreRcInner>,
}

impl CoreWeak {
    pub fn upgrade(&self) -> Option<CoreRc> {
        self.weak.upgrade().map(|inner| CoreRc { inner })
    }
}
