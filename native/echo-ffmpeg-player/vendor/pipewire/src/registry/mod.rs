// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! The registry is a singleton object that keeps track of global objects on the PipeWire instance.
//!
//! Global objects typically represent an actual object in PipeWire (for example, a module or node) or they are singleton objects such as the core.
//!
//! When a client creates a registry object, the registry object will emit a global event for each global currently in the registry.
//! Globals come and go as a result of device hotplugs or reconfiguration or other events, and the registry will send
//! out [`global`](self::ListenerLocalBuilder::global) and [`global_remove`](self::ListenerLocalBuilder::global_remove) events to keep the client up to date with the changes. To mark the end of the initial
//! burst of events, the client can use the [`Core::sync`](crate::core::Core::sync) method immediately after getting the registry from the core.
//!
//! A client can bind to a global object by using [`bind`](Registry::bind). This creates a client-side proxy that lets the
//! object emit events to the client and lets the client invoke methods on the object. See
//! [`proxy`](crate::proxy).
//!
//! Clients can also change the permissions of the global objects that they can see. This is interesting when you want to
//! configure a pipewire session before handing it to another application. You can, for example, hide certain existing
//! or new objects or limit the access permissions on an object.
//!
//! This module contains wrappers for [`pw_registry`](pw_sys::pw_registry) and related items.

use libc::{c_char, c_void};

use std::{
    ffi::{CStr, CString},
    mem,
    pin::Pin,
    ptr,
};

use crate::{
    permissions::PermissionFlags,
    properties::PropertiesBox,
    proxy::{Proxy, ProxyT},
    types::ObjectType,
    Error,
};

mod box_;
pub use box_::*;
mod rc;
pub use rc::*;

/// Transparent wrapper around a [registry](self).
///
/// This does not own the underlying object and is usually seen behind a `&` reference.
///
/// For owning wrappers, see [`RegistryBox`] and [`RegistryRc`].
///
/// For an explanation of these, see [Smart pointers to PipeWire
/// objects](crate#smart-pointers-to-pipewire-objects).
#[repr(transparent)]
pub struct Registry(pw_sys::pw_registry);

impl Registry {
    pub fn as_raw(&self) -> &pw_sys::pw_registry {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_registry {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> ListenerLocalBuilder<'_> {
        ListenerLocalBuilder {
            registry: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }

    /// Bind to a global object.
    ///
    /// Bind to the global object and get a proxy to the object. After this call, methods can be sent to the remote global object and events can be received.
    ///
    /// Usually this is called in callbacks for the [`global`](ListenerLocalBuilder::global) event.
    ///
    /// # Errors
    /// If `T` does not match the type of the global object, [`Error::WrongProxyType`] is returned.
    pub fn bind<T: ProxyT, P: AsRef<spa::utils::dict::DictRef>>(
        &self,
        object: &GlobalObject<P>,
    ) -> Result<T, Error> {
        let proxy = unsafe {
            let type_ = CString::new(object.type_.to_str()).unwrap();
            let version = object.type_.client_version();

            let proxy = spa::spa_interface_call_method!(
                self.as_raw_ptr(),
                pw_sys::pw_registry_methods,
                bind,
                object.id,
                type_.as_ptr(),
                version,
                0
            );

            proxy
        };

        let proxy = ptr::NonNull::new(proxy.cast()).ok_or(Error::NoMemory)?;

        Proxy::new(proxy).downcast().map_err(|(_, e)| e)
    }

    /// Attempt to destroy the global object with the specified id on the remote.
    ///
    /// # Permissions
    /// Requires [`X`](crate::permissions::PermissionFlags::X) permissions on the global.
    pub fn destroy_global(&self, global_id: u32) -> spa::utils::result::SpaResult {
        let result = unsafe {
            spa::spa_interface_call_method!(
                self.as_raw_ptr(),
                pw_sys::pw_registry_methods,
                destroy,
                global_id
            )
        };

        spa::utils::result::SpaResult::from_c(result)
    }
}

type GlobalCallback = dyn Fn(&GlobalObject<&spa::utils::dict::DictRef>);
type GlobalRemoveCallback = dyn Fn(u32);

#[derive(Default)]
struct ListenerLocalCallbacks {
    global: Option<Box<GlobalCallback>>,
    global_remove: Option<Box<GlobalRemoveCallback>>,
}

/// A builder for registering registry event callbacks.
///
/// Use [`Registry::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a
/// [`registry::Listener`](Listener).
///
/// # Examples
/// ```
/// # use pipewire::registry::Registry;
/// # fn example(registry: Registry) {
/// let registry_listener = registry.add_listener_local()
///     .global(|global| println!("New global: {global:?}"))
///     .global_remove(|id| println!("Global with id {id} was removed"))
///     .register();
/// # }
/// ```
pub struct ListenerLocalBuilder<'a> {
    registry: &'a Registry,
    cbs: ListenerLocalCallbacks,
}

/// An owned listener for registry events.
///
/// This is created by [`registry::ListenerLocalBuilder`](ListenerLocalBuilder) and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct Listener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_registry_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> ListenerLocalBuilder<'a> {
    /// Set the registry `global` event callback of the listener.
    ///
    /// This event is emitted when a new global object is available.
    ///
    /// # Callback parameters
    /// `global`: The new global object
    ///
    /// # Examples
    /// ```
    /// # use pipewire::registry::Registry;
    /// # fn example(registry: Registry) {
    /// let registry_listener = registry.add_listener_local()
    ///     .global(|global| println!("New global: {global:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn global<F>(mut self, global: F) -> Self
    where
        F: Fn(&GlobalObject<&spa::utils::dict::DictRef>) + 'static,
    {
        self.cbs.global = Some(Box::new(global));
        self
    }

    /// Set the registry `global_remove` event callback of the listener.
    ///
    /// This event is emitted when a global object was removed from the registry. If the client has any bindings to the global, it should destroy those.
    ///
    /// # Callback parameters
    /// `id`: The id of the global that was removed
    ///
    /// # Examples
    /// ```
    /// # use pipewire::registry::Registry;
    /// # fn example(registry: Registry) {
    /// let registry_listener = registry.add_listener_local()
    ///     .global_remove(|id| println!("Global with id {id} was removed"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn global_remove<F>(mut self, global_remove: F) -> Self
    where
        F: Fn(u32) + 'static,
    {
        self.cbs.global_remove = Some(Box::new(global_remove));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> Listener {
        unsafe extern "C" fn registry_events_global(
            data: *mut c_void,
            id: u32,
            permissions: u32,
            type_: *const c_char,
            version: u32,
            props: *const spa_sys::spa_dict,
        ) {
            let type_ = CStr::from_ptr(type_).to_str().unwrap();
            let obj = GlobalObject::new(id, permissions, type_, version, props);
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            callbacks.global.as_ref().unwrap()(&obj);
        }

        unsafe extern "C" fn registry_events_global_remove(data: *mut c_void, id: u32) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            callbacks.global_remove.as_ref().unwrap()(id);
        }

        let e = unsafe {
            let mut e: Pin<Box<pw_sys::pw_registry_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_REGISTRY_EVENTS;

            if self.cbs.global.is_some() {
                e.global = Some(registry_events_global);
            }
            if self.cbs.global_remove.is_some() {
                e.global_remove = Some(registry_events_global_remove);
            }

            e
        };

        let (listener, data) = unsafe {
            let ptr = self.registry.as_raw_ptr();
            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa::spa_interface_call_method!(
                ptr,
                pw_sys::pw_registry_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        Listener {
            events: e,
            listener,
            data,
        }
    }
}

#[derive(Debug)]
pub struct GlobalObject<P: AsRef<spa::utils::dict::DictRef>> {
    pub id: u32,
    pub permissions: PermissionFlags,
    pub type_: ObjectType,
    pub version: u32,
    pub props: Option<P>,
}

impl GlobalObject<&spa::utils::dict::DictRef> {
    unsafe fn new(
        id: u32,
        permissions: u32,
        type_: &str,
        version: u32,
        props: *const spa_sys::spa_dict,
    ) -> Self {
        let type_ = ObjectType::from_str(type_);
        let permissions = PermissionFlags::from_bits_retain(permissions);
        let props = ptr::NonNull::new(props.cast_mut())
            .map(|ptr| ptr.cast::<spa::utils::dict::DictRef>().as_ref());

        Self {
            id,
            permissions,
            type_,
            version,
            props,
        }
    }
}

impl<P: AsRef<spa::utils::dict::DictRef>> GlobalObject<P> {
    pub fn to_owned(&self) -> GlobalObject<PropertiesBox> {
        GlobalObject {
            id: self.id,
            permissions: self.permissions,
            type_: self.type_.clone(),
            version: self.version,
            props: self
                .props
                .as_ref()
                .map(|props| PropertiesBox::from_dict(props.as_ref())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn set_object_type() {
        assert_eq!(
            ObjectType::from_str("PipeWire:Interface:Client"),
            ObjectType::Client
        );
        assert_eq!(ObjectType::Client.to_str(), "PipeWire:Interface:Client");
        assert_eq!(ObjectType::Client.client_version(), 3);

        let o = ObjectType::Other("PipeWire:Interface:Badger".to_string());
        assert_eq!(ObjectType::from_str("PipeWire:Interface:Badger"), o);
        assert_eq!(o.to_str(), "PipeWire:Interface:Badger");
    }

    #[test]
    #[should_panic(expected = "Invalid object type")]
    fn client_version_panic() {
        let o = ObjectType::Other("PipeWire:Interface:Badger".to_string());
        assert_eq!(o.client_version(), 0);
    }
}
