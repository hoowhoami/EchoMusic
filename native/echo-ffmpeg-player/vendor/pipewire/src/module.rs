// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Modules implement functionality such as providing new objects or policies.
//!
//! This module contains wrappers for [`pw_module`](pw_sys::pw_module) and related items.

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

/// A [proxy][Proxy] to a [module](self).
#[derive(Debug)]
pub struct Module {
    proxy: Proxy,
}

impl ProxyT for Module {
    fn type_() -> ObjectType {
        ObjectType::Module
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

impl Module {
    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> ModuleListenerLocalBuilder<'_> {
        ModuleListenerLocalBuilder {
            module: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }
}

#[derive(Default)]
struct ListenerLocalCallbacks {
    #[allow(clippy::type_complexity)]
    info: Option<Box<dyn Fn(&ModuleInfoRef)>>,
}

/// A builder for registering module event callbacks.
///
/// Use [`Module::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`ModuleListener`].
///
/// # Examples
/// ```
/// # use pipewire::module::Module;
/// # fn example(module: Module) {
/// let module_listener = module.add_listener_local()
///     .info(|info| println!("New module info: {info:?}"))
///     .register();
/// # }
/// ```
pub struct ModuleListenerLocalBuilder<'a> {
    module: &'a Module,
    cbs: ListenerLocalCallbacks,
}

#[repr(transparent)]
pub struct ModuleInfoRef(pw_sys::pw_module_info);

impl ModuleInfoRef {
    pub fn as_raw(&self) -> &pw_sys::pw_module_info {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_module_info {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn name(&self) -> &str {
        unsafe { CStr::from_ptr(self.0.name).to_str().unwrap() }
    }

    pub fn filename(&self) -> &str {
        unsafe { CStr::from_ptr(self.0.name).to_str().unwrap() }
    }

    pub fn args(&self) -> Option<&str> {
        let args = self.0.args;
        if args.is_null() {
            None
        } else {
            Some(unsafe { CStr::from_ptr(args).to_str().unwrap() })
        }
    }

    pub fn change_mask(&self) -> ModuleChangeMask {
        ModuleChangeMask::from_bits(self.0.change_mask).expect("invalid change_mask")
    }

    pub fn props(&self) -> Option<&spa::utils::dict::DictRef> {
        let props_ptr: *mut spa::utils::dict::DictRef = self.0.props.cast();
        ptr::NonNull::new(props_ptr).map(|ptr| unsafe { ptr.as_ref() })
    }
}

impl fmt::Debug for ModuleInfoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModuleInfoRef")
            .field("id", &self.id())
            .field("filename", &self.filename())
            .field("args", &self.args())
            .field("change_mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

pub struct ModuleInfo {
    ptr: ptr::NonNull<pw_sys::pw_module_info>,
}

impl ModuleInfo {
    pub fn new(ptr: ptr::NonNull<pw_sys::pw_module_info>) -> Self {
        Self { ptr }
    }

    pub fn from_raw(raw: *mut pw_sys::pw_module_info) -> Self {
        Self {
            ptr: ptr::NonNull::new(raw).expect("Provided pointer is null"),
        }
    }

    pub fn into_raw(self) -> *mut pw_sys::pw_module_info {
        std::mem::ManuallyDrop::new(self).ptr.as_ptr()
    }
}

impl Drop for ModuleInfo {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_module_info_free(self.ptr.as_ptr()) }
    }
}

impl std::ops::Deref for ModuleInfo {
    type Target = ModuleInfoRef;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<ModuleInfoRef>().as_ref() }
    }
}

impl AsRef<ModuleInfoRef> for ModuleInfo {
    fn as_ref(&self) -> &ModuleInfoRef {
        self.deref()
    }
}

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct ModuleChangeMask: u64 {
        const PROPS = pw_sys::PW_MODULE_CHANGE_MASK_PROPS as u64;
    }
}

impl fmt::Debug for ModuleInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ModuleInfo")
            .field("id", &self.id())
            .field("filename", &self.filename())
            .field("args", &self.args())
            .field("change_mask", &self.change_mask())
            .field("props", &self.props())
            .finish()
    }
}

/// An owned listener for module events.
///
/// This is created by [`ModuleListenerLocalBuilder`] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct ModuleListener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_module_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Listener for ModuleListener {}

impl Drop for ModuleListener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> ModuleListenerLocalBuilder<'a> {
    /// Set the module `info` event callback of the listener.
    ///
    /// # Callback parameters
    /// `info`: Info about the module
    ///
    /// # Examples
    /// ```
    /// # use pipewire::module::Module;
    /// # fn example(module: Module) {
    /// let module_listener = module.add_listener_local()
    ///     .info(|info| println!("New module info: {info:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn info<F>(mut self, info: F) -> Self
    where
        F: Fn(&ModuleInfoRef) + 'static,
    {
        self.cbs.info = Some(Box::new(info));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> ModuleListener {
        unsafe extern "C" fn module_events_info(
            data: *mut c_void,
            info: *const pw_sys::pw_module_info,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let info =
                ptr::NonNull::new(info as *mut pw_sys::pw_module_info).expect("info is NULL");
            let info = info.cast::<ModuleInfoRef>().as_ref();
            callbacks.info.as_ref().unwrap()(info);
        }

        let e = unsafe {
            let mut e: Pin<Box<pw_sys::pw_module_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_MODULE_EVENTS;

            if self.cbs.info.is_some() {
                e.info = Some(module_events_info);
            }

            e
        };

        let (listener, data) = unsafe {
            let module = &self.module.proxy.as_ptr();

            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa_interface_call_method!(
                module,
                pw_sys::pw_module_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        ModuleListener {
            events: e,
            listener,
            data,
        }
    }
}
