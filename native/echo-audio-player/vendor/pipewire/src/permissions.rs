// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Permissions are used to implement [access control](https://docs.pipewire.org/page_access.html) for PipeWire clients.

use bitflags::bitflags;
use std::fmt;

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct PermissionFlags: u32 {
        /// An object with this permission is visible to the client. The client will receive registry events for the object and can interact with it.
        const R = pw_sys::PW_PERM_R;
        /// An object with this permission can be modified by the client. This is usually done through a method that modifies the state of the object. Usually implies the [`X`](Self::X) permission.
        const W = pw_sys::PW_PERM_W;
        /// An object with this permission allows invoking methods on the object. Some of those methods will only query state, others will modify the object. Modifying the object through one of these methods requires the [`W`](Self:W) permission.
        const X = pw_sys::PW_PERM_X;
        /// An object this permission can be used as the subject in metadata.
        const M = pw_sys::PW_PERM_M;
        #[cfg(feature = "v0_3_77")]
        const L = pw_sys::PW_PERM_L;
    }
}

/// A `Permission` describes (using [`PermissionFlags`]) what the client is allowed to do with the object of id [`id`](Self::id).
#[derive(Clone, Copy)]
#[repr(transparent)]
pub struct Permission(pw_sys::pw_permission);

impl Permission {
    pub fn new(id: u32, flags: PermissionFlags) -> Self {
        Self(pw_sys::pw_permission {
            id,
            permissions: flags.bits(),
        })
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn set_id(&mut self, id: u32) {
        self.0.id = id;
    }

    pub fn permission_flags(&self) -> PermissionFlags {
        PermissionFlags::from_bits_retain(self.0.permissions)
    }

    pub fn set_permission_flags(&mut self, flags: PermissionFlags) {
        self.0.permissions = flags.bits();
    }
}

impl fmt::Debug for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Permission")
            .field("id", &self.id())
            .field("permission_flags", &self.permission_flags())
            .finish()
    }
}
