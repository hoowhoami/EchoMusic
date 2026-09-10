// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use super::{Registry, RegistryBox};

#[derive(Debug)]
struct RegistryRcInner {
    registry: RegistryBox<'static>,
    // Store the core here, so that the registry is not dropped before the core,
    // which may lead to undefined behaviour. Rusts drop order of struct fields
    // (from top to bottom) ensures that this is always destroyed _after_ the registry.
    _core: crate::core::CoreRc,
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [registry](super).
///
/// For the non-owning variant, see [`RegistryWeak`].
/// For unique ownership, see [`RegistryBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug, Clone)]
pub struct RegistryRc {
    inner: Rc<RegistryRcInner>,
}

impl RegistryRc {
    /// Create a `RegistryRc` by taking ownership of a raw `pw_registry`.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_registry`](`pw_sys::pw_registry`).
    ///
    /// The raw registry must not be manually destroyed or moved, as the new [`RegistryRc`] takes
    /// ownership of it.
    pub unsafe fn from_raw(
        ptr: ptr::NonNull<pw_sys::pw_registry>,
        core: crate::core::CoreRc,
    ) -> Self {
        let registry = unsafe { RegistryBox::from_raw(ptr) };

        Self {
            inner: Rc::new(RegistryRcInner {
                registry,
                _core: core,
            }),
        }
    }

    pub fn downgrade(&self) -> RegistryWeak {
        let weak = Rc::downgrade(&self.inner);
        RegistryWeak { weak }
    }
}

impl Deref for RegistryRc {
    type Target = Registry;

    fn deref(&self) -> &Self::Target {
        self.inner.registry.deref()
    }
}

impl AsRef<Registry> for RegistryRc {
    fn as_ref(&self) -> &Registry {
        self.deref()
    }
}

/// Non-owning reference to a [registry](super) managed by [`RegistryRc`].
///
/// The registry can be accessed by calling [`upgrade`](Self::upgrade).
pub struct RegistryWeak {
    weak: Weak<RegistryRcInner>,
}

impl RegistryWeak {
    pub fn upgrade(&self) -> Option<RegistryRc> {
        self.weak.upgrade().map(|inner| RegistryRc { inner })
    }
}
