// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Clients represent an open connection of a client process with the server.
//!
//! This module contains wrappers for [`pw_client`](pw_sys::pw_client) and related items.

use bitflags::bitflags;
use libc::c_void;
use std::ops::Deref;
use std::pin::Pin;
use std::{
    ffi::{CStr, CString},
    ptr,
};
use std::{fmt, mem};

use crate::{
    permissions::Permission,
    proxy::{Listener, Proxy, ProxyT},
    types::ObjectType,
};
use spa::spa_interface_call_method;

/// A [proxy][Proxy] to a [client](self).
#[derive(Debug)]
pub struct Client {
    proxy: Proxy,
}

impl ProxyT for Client {
    fn type_() -> ObjectType {
        ObjectType::Client
    }

    fn upcast(self) -> Proxy {
        self.proxy
    }

    fn upcast_ref(&self) -> &Proxy {
        &self.proxy
    }

    unsafe fn from_proxy_unchecked(proxy: Proxy) -> Self
    where
        Self: Sized,
    {
        Self { proxy }
    }
}

impl Client {
    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> ClientListenerLocalBuilder<'_> {
        ClientListenerLocalBuilder {
            client: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }

    /// Send an error to the client.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    ///
    /// # Parameters
    /// `id`: The global id to report the error on
    /// `res`: An errno style error code
    /// `message`: An error string
    pub fn error(&self, id: u32, res: i32, message: &str) {
        let message = CString::new(message).expect("Null byte in message parameter");
        let message_cstr = message.as_c_str();
        Client::error_cstr(self, id, res, message_cstr)
    }

    /// Send an error to the client.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    ///
    /// # Parameters
    /// `id`: The global id to report the error on
    /// `res`: An errno style error code
    /// `message`: An error string
    pub fn error_cstr(&self, id: u32, res: i32, message: &CStr) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_client_methods,
                error,
                id,
                res,
                message.as_ptr() as *const _
            );
        };
    }

    /// Update the client's properties.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    pub fn update_properties(&self, properties: &spa::utils::dict::DictRef) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_client_methods,
                update_properties,
                properties.as_raw_ptr()
            );
        }
    }

    /// Get the client's permissions.
    ///
    /// A [`permissions`](ClientListenerLocalBuilder::permissions) event will be emitted.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    ///
    /// # Parameters
    /// `index`: The first index to query, `0` for first
    /// `num`: The maximum number of items to get
    pub fn get_permissions(&self, index: u32, num: u32) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_client_methods,
                get_permissions,
                index,
                num
            );
        }
    }

    /// Manage the permissions of the global objects for this client.
    ///
    /// Update the permissions of the global objects using the provided slice.
    ///
    /// Globals can use the default permissions or can have specific permissions assigned to them.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    pub fn update_permissions(&self, permissions: &[Permission]) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_client_methods,
                update_permissions,
                permissions.len() as u32,
                permissions.as_ptr().cast()
            );
        }
    }
}

#[derive(Default)]
struct ListenerLocalCallbacks {
    #[allow(clippy::type_complexity)]
    info: Option<Box<dyn Fn(&ClientInfoRef)>>,
    #[allow(clippy::type_complexity)]
    permissions: Option<Box<dyn Fn(u32, &[Permission])>>,
}

/// A builder for registering client event callbacks.
///
/// Use [`Client::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`ClientListener`].
///
/// # Examples
/// ```
/// # use pipewire::client::Client;
/// # fn example(client: Client) {
/// let client_listener = client.add_listener_local()
///     .info(|info| println!("New client info: {info:?}"))
///     .permissions(|index, permissions| {
///         println!("New client permissions: index {index}, permissions {permissions:?}");
///     })
///     .register();
/// # }
/// ```
pub struct ClientListenerLocalBuilder<'a> {
    client: &'a Client,
    cbs: ListenerLocalCallbacks,
}

#[repr(transparent)]
pub struct ClientInfoRef(pw_sys::pw_client_info);

impl ClientInfoRef {
    pub fn as_raw(&self) -> &pw_sys::pw_client_info {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_client_info {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn change_mask(&self) -> ClientChangeMask {
        ClientChangeMask::from_bits(self.0.change_mask).expect("invalid change_mask")
    }

    pub fn props(&self) -> Option<&spa::utils::dict::DictRef> {
        let props_ptr: *mut spa::utils::dict::DictRef = self.0.props.cast();
        ptr::NonNull::new(props_ptr).map(|ptr| unsafe { ptr.as_ref() })
    }
}

impl fmt::Debug for ClientInfoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientInfoRef")
            .field("id", &self.id())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

pub struct ClientInfo {
    ptr: ptr::NonNull<pw_sys::pw_client_info>,
}

impl ClientInfo {
    pub fn new(ptr: ptr::NonNull<pw_sys::pw_client_info>) -> Self {
        Self { ptr }
    }

    pub fn from_raw(raw: *mut pw_sys::pw_client_info) -> Self {
        Self {
            ptr: ptr::NonNull::new(raw).expect("Provided pointer is null"),
        }
    }

    pub fn into_raw(self) -> *mut pw_sys::pw_client_info {
        std::mem::ManuallyDrop::new(self).ptr.as_ptr()
    }
}

impl Drop for ClientInfo {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_client_info_free(self.ptr.as_ptr()) }
    }
}

impl std::ops::Deref for ClientInfo {
    type Target = ClientInfoRef;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<ClientInfoRef>().as_ref() }
    }
}

impl AsRef<ClientInfoRef> for ClientInfo {
    fn as_ref(&self) -> &ClientInfoRef {
        self.deref()
    }
}

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct ClientChangeMask: u64 {
        const PROPS = pw_sys::PW_CLIENT_CHANGE_MASK_PROPS as u64;
    }
}

impl fmt::Debug for ClientInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientInfo")
            .field("id", &self.id())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

/// An owned listener for client events.
///
/// This is created by [`ClientListenerLocalBuilder`] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct ClientListener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_client_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Listener for ClientListener {}

impl Drop for ClientListener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> ClientListenerLocalBuilder<'a> {
    /// Set the client `info` event callback of the listener.
    ///
    /// # Callback parameters
    /// `info`: Info about the client
    /// # Examples
    /// ```
    /// # use pipewire::client::Client;
    /// # fn example(client: Client) {
    /// let client_listener = client.add_listener_local()
    ///     .info(|info| println!("New client info: {info:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn info<F>(mut self, info: F) -> Self
    where
        F: Fn(&ClientInfoRef) + 'static,
    {
        self.cbs.info = Some(Box::new(info));
        self
    }

    /// Set the client `permissions` event callback of the listener.
    ///
    /// This event is emitted as a result of [`get_permissions`](Client::get_permissions).
    ///
    /// # Callback parameters
    /// `index`: Index of the first permission entry
    /// `permissions`: The permissions
    ///
    /// # Examples
    /// ```
    /// # use pipewire::client::Client;
    /// # fn example(client: Client) {
    /// let client_listener = client.add_listener_local()
    ///     .permissions(|index, permissions| {
    ///         println!("New client permissions: index {index}, permissions {permissions:?}");
    ///     })
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn permissions<F>(mut self, permissions: F) -> Self
    where
        F: Fn(u32, &[Permission]) + 'static,
    {
        self.cbs.permissions = Some(Box::new(permissions));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> ClientListener {
        unsafe extern "C" fn client_events_info(
            data: *mut c_void,
            info: *const pw_sys::pw_client_info,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let info =
                ptr::NonNull::new(info as *mut pw_sys::pw_client_info).expect("info is NULL");
            let info = info.cast::<ClientInfoRef>().as_ref();
            callbacks.info.as_ref().unwrap()(info);
        }

        unsafe extern "C" fn client_events_permissions(
            data: *mut c_void,
            index: u32,
            n_permissions: u32,
            permissions: *const pw_sys::pw_permission,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let permissions =
                std::slice::from_raw_parts(permissions.cast(), n_permissions as usize);

            callbacks.permissions.as_ref().unwrap()(index, permissions);
        }

        let e = unsafe {
            let mut e: Pin<Box<pw_sys::pw_client_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_CLIENT_EVENTS;

            if self.cbs.info.is_some() {
                e.info = Some(client_events_info);
            }
            if self.cbs.permissions.is_some() {
                e.permissions = Some(client_events_permissions);
            }

            e
        };

        let (listener, data) = unsafe {
            let client = &self.client.proxy.as_ptr();

            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa_interface_call_method!(
                client,
                pw_sys::pw_client_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        ClientListener {
            events: e,
            listener,
            data,
        }
    }
}
