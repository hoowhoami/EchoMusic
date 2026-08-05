// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Ports are attached on [nodes](crate::node) and provide interfaces for input or output of data
//! on the node.
//!
//! This module contains wrappers for [`pw_port`](pw_sys::pw_port) and related items.

use bitflags::bitflags;
use libc::c_void;
use std::ops::Deref;
use std::{fmt, mem};
use std::{pin::Pin, ptr};

use crate::{
    proxy::{Listener, Proxy, ProxyT},
    spa::utils::Direction,
    types::ObjectType,
};
use spa::{pod::Pod, spa_interface_call_method};

/// A [proxy][Proxy] to a [port](self).
#[derive(Debug)]
pub struct Port {
    proxy: Proxy,
}

impl Port {
    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> PortListenerLocalBuilder<'_> {
        PortListenerLocalBuilder {
            port: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }

    /// Subscribe to parameter changes.
    ///
    /// Automatically emit [`param`](PortListenerLocalBuilder::param) events for the `ids` when they are changed.
    ///
    /// # Permissions
    /// Requires [`X`](crate::permissions::PermissionFlags::X) permissions on the port.
    // FIXME: Return result?
    pub fn subscribe_params(&self, ids: &[spa::param::ParamType]) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_port_methods,
                subscribe_params,
                ids.as_ptr() as *mut _,
                ids.len().try_into().unwrap()
            );
        }
    }

    /// Enumerate node parameters
    ///
    /// Start enumeration of node parameters. For each param, a
    /// [`param`](PortListenerLocalBuilder::param) event will be emitted.
    ///
    /// # Permissions
    /// Requires [`X`](crate::permissions::PermissionFlags::X) permissions on the port.
    ///
    /// # Parameters
    /// `seq`: a sequence number to place in the reply \
    /// `id`: the parameter id to enum, or [`None`] to allow any id \
    /// `start`: the start index or 0 for the first param \
    /// `num`: the maximum number of params to retrieve ([`u32::MAX`] may be used to retrieve all params)
    // FIXME: Add filter parameter
    // FIXME: Return result?
    pub fn enum_params(&self, seq: i32, id: Option<spa::param::ParamType>, start: u32, num: u32) {
        let id = id.map(|id| id.as_raw()).unwrap_or(crate::constants::ID_ANY);

        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_node_methods,
                enum_params,
                seq,
                id,
                start,
                num,
                std::ptr::null()
            );
        }
    }
}

impl ProxyT for Port {
    fn type_() -> ObjectType {
        ObjectType::Port
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

#[derive(Default)]
struct ListenerLocalCallbacks {
    #[allow(clippy::type_complexity)]
    info: Option<Box<dyn Fn(&PortInfoRef)>>,
    #[allow(clippy::type_complexity)]
    param: Option<Box<dyn Fn(i32, spa::param::ParamType, u32, u32, Option<&Pod>)>>,
}

/// A builder for registering port event callbacks.
///
/// Use [`Port::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`PortListener`].
///
/// # Examples
/// ```
/// # use pipewire::port::Port;
/// # use pipewire::spa::pod::Pod;
/// # fn example(port: Port) {
/// let port_listener = port.add_listener_local()
///     .info(|info| println!("New port info: {info:?}"))
///     .param(|seq, param_type, index, next, param| {
///         println!("New port param: seq {seq}, param type {param_type:?}, index {index}, next {next}, param {:?}",
///             param.map(Pod::as_bytes));
///     })
///     .register();
/// # }
/// ```
pub struct PortListenerLocalBuilder<'a> {
    port: &'a Port,
    cbs: ListenerLocalCallbacks,
}

#[repr(transparent)]
pub struct PortInfoRef(pw_sys::pw_port_info);

impl PortInfoRef {
    pub fn as_raw(&self) -> &pw_sys::pw_port_info {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_port_info {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn direction(&self) -> Direction {
        Direction::from_raw(self.0.direction)
    }

    pub fn change_mask(&self) -> PortChangeMask {
        PortChangeMask::from_bits_retain(self.0.change_mask)
    }

    pub fn props(&self) -> Option<&spa::utils::dict::DictRef> {
        let props_ptr: *mut spa::utils::dict::DictRef = self.0.props.cast();
        ptr::NonNull::new(props_ptr).map(|ptr| unsafe { ptr.as_ref() })
    }

    /// Get the param infos for the port.
    pub fn params(&self) -> &[spa::param::ParamInfo] {
        let params = self.0.params;
        if params.is_null() {
            &[]
        } else {
            unsafe {
                std::slice::from_raw_parts(params as *const _, self.0.n_params.try_into().unwrap())
            }
        }
    }
}

impl fmt::Debug for PortInfoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PortInfoRef")
            .field("id", &self.id())
            .field("direction", &self.direction())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .field("params", &self.params())
            .finish()
    }
}

pub struct PortInfo {
    ptr: ptr::NonNull<pw_sys::pw_port_info>,
}

impl PortInfo {
    pub fn new(ptr: ptr::NonNull<pw_sys::pw_port_info>) -> Self {
        Self { ptr }
    }

    pub fn from_raw(raw: *mut pw_sys::pw_port_info) -> Self {
        Self {
            ptr: ptr::NonNull::new(raw).expect("Provided pointer is null"),
        }
    }

    pub fn into_raw(self) -> *mut pw_sys::pw_port_info {
        std::mem::ManuallyDrop::new(self).ptr.as_ptr()
    }
}

impl Drop for PortInfo {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_port_info_free(self.ptr.as_ptr()) }
    }
}

impl std::ops::Deref for PortInfo {
    type Target = PortInfoRef;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<PortInfoRef>().as_ref() }
    }
}

impl AsRef<PortInfoRef> for PortInfo {
    fn as_ref(&self) -> &PortInfoRef {
        self.deref()
    }
}

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct PortChangeMask: u64 {
        const PROPS = pw_sys::PW_PORT_CHANGE_MASK_PROPS as u64;
        const PARAMS = pw_sys::PW_PORT_CHANGE_MASK_PARAMS as u64;
    }
}

impl fmt::Debug for PortInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PortInfo")
            .field("id", &self.id())
            .field("direction", &self.direction())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .field("params", &self.params())
            .finish()
    }
}

/// An owned listener for port events.
///
/// This is created by [`PortListenerLocalBuilder`] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct PortListener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_port_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Listener for PortListener {}

impl Drop for PortListener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> PortListenerLocalBuilder<'a> {
    /// Set the port `info` event callback of the listener.
    ///
    /// # Callback parameters
    /// `info`: Info about the port.
    ///
    /// # Examples
    /// ```
    /// # use pipewire::port::Port;
    /// # fn example(port: Port) {
    /// let port_listener = port.add_listener_local()
    ///     .info(|info| println!("New port info: {info:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn info<F>(mut self, info: F) -> Self
    where
        F: Fn(&PortInfoRef) + 'static,
    {
        self.cbs.info = Some(Box::new(info));
        self
    }

    /// Set the port `param` event callback of the listener.
    ///
    /// This event is emitted as a result of [`enum_params`](Port::enum_params) or
    /// [`subscribe_params`](Port::subscribe_params).
    ///
    /// # Callback parameters
    /// `seq`: The sequence number of the request
    /// `param_type`: The param type
    /// `index`: The param index
    /// `next`: The param index of the next param
    /// `param`: The param
    ///
    /// # Examples
    /// ```
    /// # use pipewire::port::Port;
    /// # use pipewire::spa::pod::Pod;
    /// # fn example(port: Port) {
    /// let port_listener = port.add_listener_local()
    ///     .param(|seq, param_type, index, next, param| {
    ///         println!("New port param: seq {seq}, param type {param_type:?}, index {index}, next {next}, param {:?}",
    ///             param.map(Pod::as_bytes));
    ///     })
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn param<F>(mut self, param: F) -> Self
    where
        F: Fn(i32, spa::param::ParamType, u32, u32, Option<&Pod>) + 'static,
    {
        self.cbs.param = Some(Box::new(param));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> PortListener {
        unsafe extern "C" fn port_events_info(
            data: *mut c_void,
            info: *const pw_sys::pw_port_info,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let info = ptr::NonNull::new(info as *mut pw_sys::pw_port_info).expect("info is NULL");
            let info = info.cast::<PortInfoRef>().as_ref();
            callbacks.info.as_ref().unwrap()(info);
        }

        unsafe extern "C" fn port_events_param(
            data: *mut c_void,
            seq: i32,
            id: u32,
            index: u32,
            next: u32,
            param: *const spa_sys::spa_pod,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();

            let id = spa::param::ParamType::from_raw(id);
            let param = if !param.is_null() {
                unsafe { Some(Pod::from_raw(param)) }
            } else {
                None
            };

            callbacks.param.as_ref().unwrap()(seq, id, index, next, param);
        }

        let e = unsafe {
            let mut e: Pin<Box<pw_sys::pw_port_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_PORT_EVENTS;

            if self.cbs.info.is_some() {
                e.info = Some(port_events_info);
            }
            if self.cbs.param.is_some() {
                e.param = Some(port_events_param);
            }

            e
        };

        let (listener, data) = unsafe {
            let port = &self.port.proxy.as_ptr();

            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa_interface_call_method!(
                port,
                pw_sys::pw_port_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        PortListener {
            events: e,
            listener,
            data,
        }
    }
}
