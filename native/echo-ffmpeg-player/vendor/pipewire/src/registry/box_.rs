// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{marker::PhantomData, ops::Deref, ptr};

use crate::core::Core;

use super::Registry;

/// Smart pointer providing unique ownership of a PipeWire [registry](super).
///
/// For shared ownership, see [`RegistryRc`](super::RegistryRc).
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Debug)]
pub struct RegistryBox<'c> {
    ptr: ptr::NonNull<pw_sys::pw_registry>,
    core: PhantomData<&'c Core>,
}

impl<'c> RegistryBox<'c> {
    /// Create a `RegistryBox` by taking ownership of a raw `pw_registry`.
    ///
    /// # Safety
    /// The provided pointer must point to a valid, well aligned [`pw_registry`](`pw_sys::pw_registry`).
    ///
    /// The raw registry must not be manually destroyed or moved, as the new [`RegistryBox`] takes
    /// ownership of it.
    ///
    /// The lifetime of the returned box is unbounded. The caller is responsible to make sure
    /// that the core used with this registry outlives the registry.
    pub unsafe fn from_raw(ptr: ptr::NonNull<pw_sys::pw_registry>) -> Self {
        Self {
            ptr,
            core: PhantomData,
        }
    }
}

impl<'c> std::ops::Deref for RegistryBox<'c> {
    type Target = Registry;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<Registry>().as_ref() }
    }
}

impl<'c> AsRef<Registry> for RegistryBox<'c> {
    fn as_ref(&self) -> &Registry {
        self.deref()
    }
}

impl<'c> Drop for RegistryBox<'c> {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_proxy_destroy(self.as_raw_ptr().cast());
        }
    }
}
