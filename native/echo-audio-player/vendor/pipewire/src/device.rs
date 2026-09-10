// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Devices model physical hardware or software devices in the system and can create other objects such as nodes or other devices.
//!
//! This module contains wrappers for [`pw_device`](pw_sys::pw_device) and related items.

use bitflags::bitflags;
use libc::c_void;
use std::ops::Deref;
use std::{fmt, mem};
use std::{pin::Pin, ptr};

use crate::{
    proxy::{Listener, Proxy, ProxyT},
    types::ObjectType,
};
use spa::{pod::Pod, spa_interface_call_method};

/// A [proxy][Proxy] to a [device](self).
#[derive(Debug)]
pub struct Device {
    proxy: Proxy,
}

impl Device {
    // TODO: add non-local version when we'll bind pw_thread_loop_start()
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_listener_local(&self) -> DeviceListenerLocalBuilder<'_> {
        DeviceListenerLocalBuilder {
            device: self,
            cbs: ListenerLocalCallbacks::default(),
        }
    }

    /// Subscribe to parameter changes.
    ///
    /// Automatically emit [`param`](DeviceListenerLocalBuilder::param) events for the `ids` when they are changed.
    ///
    /// # Permissions
    /// Requires [`X`](crate::permissions::PermissionFlags::X) permissions on the device.
    // FIXME: Return result?
    pub fn subscribe_params(&self, ids: &[spa::param::ParamType]) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_device_methods,
                subscribe_params,
                ids.as_ptr() as *mut _,
                ids.len().try_into().unwrap()
            );
        }
    }

    /// Enumerate device parameters.
    ///
    /// Start enumeration of device parameters. For each param, a
    /// [`param`](DeviceListenerLocalBuilder::param) event will be emitted.
    ///
    /// # Permissions
    /// Requires [`X`](crate::permissions::PermissionFlags::X) permissions on the device.
    ///
    /// # Parameters
    /// `seq`: A sequence number to place in the reply \
    /// `id`: The parameter id to enum, or [`None`] to allow any id \
    /// `start`: The start index or 0 for the first param \
    /// `num`: The maximum number of params to retrieve ([`u32::MAX`] may be used to retrieve all params)
    // FIXME: Add filter parameter
    // FIXME: Return result?
    pub fn enum_params(&self, seq: i32, id: Option<spa::param::ParamType>, start: u32, num: u32) {
        let id = id.map(|id| id.as_raw()).unwrap_or(crate::constants::ID_ANY);

        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_device_methods,
                enum_params,
                seq,
                id,
                start,
                num,
                std::ptr::null()
            );
        }
    }

    /// Set a parameter on the device.
    ///
    /// # Permissions
    /// Requires [`W`](crate::permissions::PermissionFlags::W) and
    /// [`X`](crate::permissions::PermissionFlags::X) permissions on the client.
    pub fn set_param(&self, id: spa::param::ParamType, flags: u32, param: &Pod) {
        unsafe {
            spa_interface_call_method!(
                self.proxy.as_ptr(),
                pw_sys::pw_device_methods,
                set_param,
                id.as_raw(),
                flags,
                param.as_raw_ptr()
            );
        }
    }
}

impl ProxyT for Device {
    fn type_() -> ObjectType {
        ObjectType::Device
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
    info: Option<Box<dyn Fn(&DeviceInfoRef)>>,
    #[allow(clippy::type_complexity)]
    param: Option<Box<dyn Fn(i32, spa::param::ParamType, u32, u32, Option<&Pod>)>>,
}

/// A builder for registering device event callbacks.
///
/// Use [`Device::add_listener_local`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`DeviceListener`].
///
/// # Examples
/// ```
/// # use pipewire::device::Device;
/// # use pipewire::spa::pod::Pod;
/// # fn example(device: Device) {
/// let device_listener = device.add_listener_local()
///     .info(|info| println!("New device info: {info:?}"))
///     .param(|seq, param_type, index, next, param| {
///         println!("New device param: seq {seq}, param type {param_type:?}, index {index}, next {next}, param {:?}",
///             param.map(Pod::as_bytes));
///     })
///     .register();
/// # }
/// ```
pub struct DeviceListenerLocalBuilder<'a> {
    device: &'a Device,
    cbs: ListenerLocalCallbacks,
}

#[repr(transparent)]
pub struct DeviceInfoRef(pw_sys::pw_device_info);

impl DeviceInfoRef {
    pub fn as_raw(&self) -> &pw_sys::pw_device_info {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_device_info {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn id(&self) -> u32 {
        self.0.id
    }

    pub fn change_mask(&self) -> DeviceChangeMask {
        DeviceChangeMask::from_bits(self.0.change_mask).expect("invalid change_mask")
    }
    pub fn props(&self) -> Option<&spa::utils::dict::DictRef> {
        let props_ptr: *mut spa::utils::dict::DictRef = self.0.props.cast();
        ptr::NonNull::new(props_ptr).map(|ptr| unsafe { ptr.as_ref() })
    }

    /// Get the param infos for the device.
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

impl fmt::Debug for DeviceInfoRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceInfoRef")
            .field("id", &self.id())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .field("params", &self.params())
            .finish()
    }
}

pub struct DeviceInfo {
    ptr: ptr::NonNull<pw_sys::pw_device_info>,
}

impl DeviceInfo {
    pub fn new(ptr: ptr::NonNull<pw_sys::pw_device_info>) -> Self {
        Self { ptr }
    }

    pub fn from_raw(raw: *mut pw_sys::pw_device_info) -> Self {
        Self {
            ptr: ptr::NonNull::new(raw).expect("Provided pointer is null"),
        }
    }

    pub fn into_raw(self) -> *mut pw_sys::pw_device_info {
        std::mem::ManuallyDrop::new(self).ptr.as_ptr()
    }
}

impl Drop for DeviceInfo {
    fn drop(&mut self) {
        unsafe { pw_sys::pw_device_info_free(self.ptr.as_ptr()) }
    }
}

impl std::ops::Deref for DeviceInfo {
    type Target = DeviceInfoRef;

    fn deref(&self) -> &Self::Target {
        unsafe { self.ptr.cast::<DeviceInfoRef>().as_ref() }
    }
}

impl AsRef<DeviceInfoRef> for DeviceInfo {
    fn as_ref(&self) -> &DeviceInfoRef {
        self.deref()
    }
}

bitflags! {
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct DeviceChangeMask: u64 {
        const PROPS = pw_sys::PW_DEVICE_CHANGE_MASK_PROPS as u64;
        const PARAMS = pw_sys::PW_DEVICE_CHANGE_MASK_PARAMS as u64;
    }
}

impl fmt::Debug for DeviceInfo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceInfo")
            .field("id", &self.id())
            .field("change-mask", &self.change_mask())
            .field("props", &self.props())
            .field("params", &self.params())
            .finish()
    }
}

/// An owned listener for device events.
///
/// This is created by [`DeviceListenerLocalBuilder`] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct DeviceListener {
    // Need to stay allocated while the listener is registered
    #[allow(dead_code)]
    events: Pin<Box<pw_sys::pw_device_events>>,
    listener: Pin<Box<spa_sys::spa_hook>>,
    #[allow(dead_code)]
    data: Box<ListenerLocalCallbacks>,
}

impl Listener for DeviceListener {}

impl Drop for DeviceListener {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

impl<'a> DeviceListenerLocalBuilder<'a> {
    /// Set the device `info` event callback of the listener.
    ///
    /// # Callback parameters
    /// `info`: Info about the device
    /// # Examples
    /// ```
    /// # use pipewire::device::Device;
    /// # use pipewire::spa::pod::Pod;
    /// # fn example(device: Device) {
    /// let device_listener = device.add_listener_local()
    ///     .info(|info| println!("New device info: {info:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn info<F>(mut self, info: F) -> Self
    where
        F: Fn(&DeviceInfoRef) + 'static,
    {
        self.cbs.info = Some(Box::new(info));
        self
    }

    /// Set the device `param` event callback of the listener.
    ///
    /// This event is emitted as a result of [`enum_params`](Device::enum_params) or
    /// [`subscribe_params`](Device::subscribe_params).
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
    /// # use pipewire::device::Device;
    /// # use pipewire::spa::pod::Pod;
    /// # fn example(device: Device) {
    /// let device_listener = device.add_listener_local()
    ///     .param(|seq, param_type, index, next, param| {
    ///         println!("New device param: seq {seq}, param type {param_type:?}, index {index}, next {next}, param {:?}",
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
    pub fn register(self) -> DeviceListener {
        unsafe extern "C" fn device_events_info(
            data: *mut c_void,
            info: *const pw_sys::pw_device_info,
        ) {
            let callbacks = (data as *mut ListenerLocalCallbacks).as_ref().unwrap();
            let info =
                ptr::NonNull::new(info as *mut pw_sys::pw_device_info).expect("info is NULL");
            let info = info.cast::<DeviceInfoRef>().as_ref();
            callbacks.info.as_ref().unwrap()(info);
        }

        unsafe extern "C" fn device_events_param(
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
            let mut e: Pin<Box<pw_sys::pw_device_events>> = Box::pin(mem::zeroed());
            e.version = pw_sys::PW_VERSION_DEVICE_EVENTS;

            if self.cbs.info.is_some() {
                e.info = Some(device_events_info);
            }
            if self.cbs.param.is_some() {
                e.param = Some(device_events_param);
            }

            e
        };

        let (listener, data) = unsafe {
            let device = &self.device.proxy.as_ptr();

            let data = Box::into_raw(Box::new(self.cbs));
            let mut listener: Pin<Box<spa_sys::spa_hook>> = Box::pin(mem::zeroed());
            let listener_ptr: *mut spa_sys::spa_hook = listener.as_mut().get_unchecked_mut();

            spa_interface_call_method!(
                device,
                pw_sys::pw_device_methods,
                add_listener,
                listener_ptr.cast(),
                e.as_ref().get_ref(),
                data as *mut _
            );

            (listener, Box::from_raw(data))
        };

        DeviceListener {
            events: e,
            listener,
            data,
        }
    }
}
