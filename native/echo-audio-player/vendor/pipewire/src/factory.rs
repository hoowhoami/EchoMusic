// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Factories are objects that create other objects.
//!
//! This module contains wrappers for [`pw_factory`](pw_sys::pw_factory) and related items.

use bitflags::bitflags;
use libc::c_void;
use std::ops::Deref;
use std::pin::Pin;
use std::{ffi::CStr, ptr};
use std::{fmt, mem};

use crate::{
    proxy::{Listener, Proxy, ProxyT},
    types::ObjectType,
};
use spa::spa_interface_call_method;

/// A [proxy][Proxy] to a [factory](self).
#[derive(Debug)]
pub struct Factory {
    proxy: Proxy,
}

impl ProxyT for Factory {
    fn type_() -> ObjectType {
        ObjectType::Factory
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

impl Factory {
    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> FactoryListenerLocalBuilder<'_> {
        FactoryListenerLocalBuilder {
            factory: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }
}

#[derive(Default)]
struct ListenerLocalCallbacks {
    #[allow(clippy::type_complexity)]
    info: Option<Box<dyn Fn(&FactoryInfoRef)>>,
}

/// A builder for registering factory event callbacks.
///
/// Use [`Factory::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`FactoryListener`].
///
/// # Examples
/// ```
/// # use pipewire::factory::Factory;
/// # fn example(factory: Factory) {
/// let factory_listener = factory.add_listener_local()
///     .info(|info| println!("New factory info: {info:?}"))
///     .register();
/// # }
/// ```
pub struct FactoryListenerLocalBuilder<'a> {
    factory: &'a Factory,
    cbs: ListenerLocalCallbacks,
}

#[repr(transparent)]
pub struct FactoryInfoRef(pw_sys::pw_factory_info);

impl FactoryInfoRef {
    pub fn as_raw(&self) -> &pw_sys::pw_factory_info {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_factory_info {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn type_(&self) -> ObjectType {
        ObjectType::from_str(unsafe { CStr::from_ptr(self.0.type_).to_str().unwrap() })
    }

    pub fn version(&self) -> u32 {
        self.0.version
    }

    pub fn change_mask(&self) -> FactoryChangeMask {
        FactoryChangeMask::from_bits(self.0.change_mask).expect("invalid change_mask")
    }

    pub fn props(&self) -> Option<&spa::utils::dict::DictRef> {
        let props_ptr: *mut spa::utils::dict::DictRef = self.0.props.cast();
        ptr::NonNull::new(props_ptr).map(|ptr| unsafe { ptr.as_ref() })
    }
}

impl fmt::Debug for FactoryInfoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FactoryInfoRef")
            .field("id", &self.id())
            .field("type", &self.type_())
            .field("version", &self.version())
            .field("change_mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

pub struct FactoryInfo {
    ptr: ptr::NonNull<pw_sys::pw_factory_info>,
}

impl FactoryInfo {
    pub fn new(ptr: ptr::NonNull<pw_sys::pw_factory_info>) -> Self {
        Self { ptr }
    }

    pub fn from_raw(raw: *mut pw_sys::pw_factory_info) -> Self {
        Self {
            ptr: ptr::NonNull::new(raw).expect("Provided pointer is null"),
        }
    }

    pub fn into_raw(self) -> *mut pw_sys::pw_factory_info {
        std::mem::ManuallyDrop::new(self).ptr.as_ptr()
    }
}

impl Drop for FactoryInfo {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_factory_info_free(self.ptr.as_ptr()) }
    }
}

impl std::ops::Deref for FactoryInfo {
    type Target = FactoryInfoRef;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<FactoryInfoRef>().as_ref() }
    }
}

impl AsRef<FactoryInfoRef> for FactoryInfo {
    fn as_ref(&self) -> &FactoryInfoRef {
        self.deref()
    }
}

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct FactoryChangeMask: u64 {
        const PROPS = pw_sys::PW_FACTORY_CHANGE_MASK_PROPS as u64;
    }
}

impl fmt::Debug for FactoryInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("FactoryInfo")
            .field("id", &self.id())
            .field("type", &self.type_())
            .field("version", &self.version())
            .field("change_mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

/// An owned listener for factory events.
///
/// This is created by [`FactoryListenerLocalBuilder`] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct FactoryListener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_factory_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Listener for FactoryListener {}

impl Drop for FactoryListener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> FactoryListenerLocalBuilder<'a> {
    /// Set the factory `info` event callback of the listener.
    ///
    /// # Callback parameters
    /// `info`: Info about the factory
    ///
    /// # Examples
    /// ```
    /// # use pipewire::factory::Factory;
    /// # fn example(factory: Factory) {
    /// let factory_listener = factory.add_listener_local()
    ///     .info(|info| println!("New factory info: {info:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn info<F>(mut self, info: F) -> Self
    where
        F: Fn(&FactoryInfoRef) + 'static,
    {
        self.cbs.info = Some(Box::new(info));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> FactoryListener {
        unsafe extern "C" fn factory_events_info(
            data: *mut c_void,
            info: *const pw_sys::pw_factory_info,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let info =
                ptr::NonNull::new(info as *mut pw_sys::pw_factory_info).expect("info is NULL");
            let info = info.cast::<FactoryInfoRef>().as_ref();
            callbacks.info.as_ref().unwrap()(info);
        }

        let e = unsafe {
            let mut e: Pin<Box<pw_sys::pw_factory_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_FACTORY_EVENTS;

            if self.cbs.info.is_some() {
                e.info = Some(factory_events_info);
            }

            e
        };

        let (listener, data) = unsafe {
            let factory = &self.factory.proxy.as_ptr();

            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa_interface_call_method!(
                factory,
                pw_sys::pw_factory_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        FactoryListener {
            events: e,
            listener,
            data,
        }
    }
}
