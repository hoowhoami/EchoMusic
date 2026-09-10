// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! Streams are higher-level objects providing a convenient way to send and receive data streams to/from PipeWire.
//!
//! This module contains wrappers for [`pw_stream`](pw_sys::pw_stream) and related itmes.

use crate::buffer::Buffer;
use crate::{error::Error, properties::Properties};
use bitflags::bitflags;
use spa::utils::result::SpaResult;
use std::{
    ffi::{self, CStr, CString},
    fmt::Debug,
    mem, os,
    pin::Pin,
    ptr,
};

mod box_;
pub use box_::*;
mod rc;
pub use rc::*;

#[derive(Debug, PartialEq)]
pub enum StreamState {
    Error(String),
    Unconnected,
    Connecting,
    Paused,
    Streaming,
}

impl StreamState {
    pub(crate) fn from_raw(state: pw_sys::pw_stream_state, error: *const os::raw::c_char) -> Self {
        match state {
            pw_sys::pw_stream_state_PW_STREAM_STATE_UNCONNECTED => StreamState::Unconnected,
            pw_sys::pw_stream_state_PW_STREAM_STATE_CONNECTING => StreamState::Connecting,
            pw_sys::pw_stream_state_PW_STREAM_STATE_PAUSED => StreamState::Paused,
            pw_sys::pw_stream_state_PW_STREAM_STATE_STREAMING => StreamState::Streaming,
            _ => {
                let error = if error.is_null() {
                    "".to_string()
                } else {
                    unsafe { ffi::CStr::from_ptr(error).to_string_lossy().to_string() }
                };

                StreamState::Error(error)
            }
        }
    }
}

/// Stream timing information, updated every graph cycle.
///
/// Obtained from [`Stream::time()`].
/// The [`now`](Self::now) field holds the timestamp of the last update;
/// compare it with `pw_stream_get_nsec()` to interpolate the current position.
///
/// All timing values are relative to the stream's rate.
///
/// For a detailed description, see [`pw_time`'s documentation](https://docs.pipewire.org/structpw__time.html#details).
#[repr(transparent)]
pub struct Time(pw_sys::pw_time);

impl Clone for Time {
    fn clone(&self) -> Self {
        Self(pw_sys::pw_time { ..self.0 })
    }
}

impl Time {
    pub fn as_raw(&self) -> &pw_sys::pw_time {
        &self.0
    }

    /// The monotonic timestamp (in nanoseconds) of this report.
    pub fn now(&self) -> i64 {
        self.0.now
    }

    /// The rate of `ticks` and `delay`, usually expressed as 1/samplerate.
    pub fn rate(&self) -> spa::utils::Fraction {
        self.0.rate
    }

    /// Monotonically increasing stream position in ticks.
    pub fn ticks(&self) -> u64 {
        self.0.ticks
    }

    /// Delay to device in ticks, including all filters on the path. Can be
    /// negative.
    ///
    /// Convert to seconds using `delay * rate.num / rate.denom`.
    pub fn delay(&self) -> i64 {
        self.0.delay
    }

    /// Total bytes queued in the stream.
    pub fn queued(&self) -> u64 {
        self.0.queued
    }

    /// Extra frames buffered in the resampler. Since PipeWire 0.3.50.
    #[cfg(feature = "v0_3_50")]
    pub fn buffered(&self) -> u64 {
        0
    }

    /// Number of buffers currently queued. Since PipeWire 0.3.50.
    #[cfg(feature = "v0_3_50")]
    pub fn queued_buffers(&self) -> u32 {
        0
    }

    /// Number of buffers available to dequeue. Since PipeWire 0.3.50.
    #[cfg(feature = "v0_3_50")]
    pub fn avail_buffers(&self) -> u32 {
        0
    }
}

impl Debug for Time {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut s = f.debug_struct("Time");
        s.field("now", &self.now())
            .field("rate", &self.rate())
            .field("ticks", &self.ticks())
            .field("delay", &self.delay())
            .field("queued", &self.queued());

        #[cfg(feature = "v0_3_50")]
        s.field("buffered", &self.buffered())
            .field("queued_buffers", &self.queued_buffers())
            .field("avail_buffers", &self.avail_buffers());

        s.finish()
    }
}

/// Transparent wrapper around a [stream](self).
///
/// This does not own the underlying object and is usually seen behind a `&` reference.
///
/// For owning wrappers that can construct streams, see [`StreamBox`] and [`StreamRc`].
///
/// For an explanation of these, see [Smart pointers to PipeWire
/// objects](crate#smart-pointers-to-pipewire-objects).
#[repr(transparent)]
pub struct Stream(pw_sys::pw_stream);

impl Stream {
    pub fn as_raw(&self) -> &pw_sys::pw_stream {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_stream {
        ptr::addr_of!(self.0).cast_mut()
    }

    /// Add a local listener builder
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_local_listener_with_user_data<D>(
        &self,
        user_data: D,
    ) -> ListenerLocalBuilder<'_, D> {
        let mut callbacks = ListenerLocalCallbacks::with_user_data(user_data);
        callbacks.stream =
            Some(ptr::NonNull::new(self.as_raw_ptr()).expect("Pointer should be nonnull"));
        ListenerLocalBuilder {
            stream: self,
            callbacks,
        }
    }

    /// Add a local listener builder. User data is initialized with its default value
    #[must_use = "Use the builder to register event callbacks"]
    pub fn add_local_listener<D: Default>(&self) -> ListenerLocalBuilder<'_, D> {
        self.add_local_listener_with_user_data(Default::default())
    }

    /// Connect the stream
    ///
    /// Tries to connect to the node `id` in the given `direction`. If no node
    /// is provided then any suitable node will be used.
    // FIXME: high-level API for params
    pub fn connect(
        &self,
        direction: spa::utils::Direction,
        id: Option<u32>,
        flags: StreamFlags,
        params: &mut [&spa::pod::Pod],
    ) -> Result<(), Error> {
        let r = unsafe {
            pw_sys::pw_stream_connect(
                self.as_raw_ptr(),
                direction.as_raw(),
                id.unwrap_or(crate::constants::ID_ANY),
                flags.bits(),
                // We cast from *mut [&spa::pod::Pod] to *mut [*const spa_sys::spa_pod] here,
                // which is valid because spa::pod::Pod is a transparent wrapper around spa_sys::spa_pod
                params.as_mut_ptr().cast(),
                params.len() as u32,
            )
        };

        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    /// Update Parameters
    ///
    /// Call from the `param_changed` callback to negotiate a new set of
    /// parameters for the stream.
    // FIXME: high-level API for params
    pub fn update_params(&self, params: &mut [&spa::pod::Pod]) -> Result<(), Error> {
        let r = unsafe {
            pw_sys::pw_stream_update_params(
                self.as_raw_ptr(),
                params.as_mut_ptr().cast(),
                params.len() as u32,
            )
        };

        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    /// Activate or deactivate the stream
    pub fn set_active(&self, active: bool) -> Result<(), Error> {
        let r = unsafe { pw_sys::pw_stream_set_active(self.as_raw_ptr(), active) };

        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    /// Take a Buffer from the Stream
    ///
    /// Removes a buffer from the stream. If this is an input stream the buffer
    /// will contain data ready to process. If this is an output stream it can
    /// be filled.
    ///
    /// # Safety
    ///
    /// The pointer returned could be NULL if no buffer is available. The buffer
    /// should be returned to the stream once processing is complete.
    pub unsafe fn dequeue_raw_buffer(&self) -> *mut pw_sys::pw_buffer {
        pw_sys::pw_stream_dequeue_buffer(self.as_raw_ptr())
    }

    pub fn dequeue_buffer(&self) -> Option<Buffer<'_>> {
        unsafe { Buffer::from_raw(self.dequeue_raw_buffer(), self) }
    }

    /// Return a Buffer to the Stream
    ///
    /// Give back a buffer once processing is complete. Use this to queue up a
    /// frame for an output stream, or return the buffer to the pool ready to
    /// receive new data for an input stream.
    ///
    /// # Safety
    ///
    /// The buffer pointer should be one obtained from this stream instance by
    /// a call to [Self::dequeue_raw_buffer()].
    pub unsafe fn queue_raw_buffer(&self, buffer: *mut pw_sys::pw_buffer) {
        pw_sys::pw_stream_queue_buffer(self.as_raw_ptr(), buffer);
    }

    /// Disconnect the stream
    pub fn disconnect(&self) -> Result<(), Error> {
        let r = unsafe { pw_sys::pw_stream_disconnect(self.as_raw_ptr()) };

        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    /// Set the stream in error state
    ///
    /// # Panics
    /// Will panic if `error` contains a 0 byte.
    ///
    pub fn set_error(&mut self, res: i32, error: &str) {
        let error = CString::new(error).expect("failed to convert error to CString");
        let error_cstr = error.as_c_str();
        Stream::set_error_cstr(self, res, error_cstr)
    }

    /// Set the stream in error state with CStr
    ///
    /// # Panics
    /// Will panic if `error` contains a 0 byte.
    ///
    pub fn set_error_cstr(&mut self, res: i32, error: &CStr) {
        unsafe {
            pw_sys::pw_stream_set_error(self.as_raw_ptr(), res, error.as_ptr());
        }
    }

    /// Flush the stream. When  `drain` is `true`, the `drained` callback will
    /// be called when all data is played or recorded.
    pub fn flush(&self, drain: bool) -> Result<(), Error> {
        let r = unsafe { pw_sys::pw_stream_flush(self.as_raw_ptr(), drain) };

        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    pub fn set_control(&self, id: u32, values: &[f32]) -> Result<(), Error> {
        let r = unsafe {
            pw_sys::pw_stream_set_control(
                self.as_raw_ptr(),
                id,
                values.len() as u32,
                values.as_ptr() as *mut f32,
            )
        };
        SpaResult::from_c(r).into_sync_result()?;
        Ok(())
    }

    // getters

    /// Get the name of the stream.
    pub fn name(&self) -> String {
        let name = unsafe {
            let name = pw_sys::pw_stream_get_name(self.as_raw_ptr());
            CStr::from_ptr(name)
        };

        name.to_string_lossy().to_string()
    }

    /// Get the current state of the stream.
    pub fn state(&self) -> StreamState {
        let mut error: *const std::os::raw::c_char = ptr::null();
        let state = unsafe {
            pw_sys::pw_stream_get_state(self.as_raw_ptr(), (&mut error) as *mut *const _)
        };
        StreamState::from_raw(state, error)
    }

    /// Get the properties of the stream.
    pub fn properties(&self) -> &Properties {
        unsafe {
            let props = pw_sys::pw_stream_get_properties(self.as_raw_ptr());
            let props = ptr::NonNull::new(props.cast_mut()).expect("stream properties is NULL");
            props.cast().as_ref()
        }
    }

    /// Get the node ID of the stream.
    pub fn node_id(&self) -> u32 {
        unsafe { pw_sys::pw_stream_get_node_id(self.as_raw_ptr()) }
    }

    #[cfg(feature = "v0_3_34")]
    pub fn is_driving(&self) -> bool {
        unsafe { pw_sys::pw_stream_is_driving(self.as_raw_ptr()) }
    }

    #[cfg(feature = "v0_3_34")]
    pub fn trigger_process(&self) -> Result<(), Error> {
        let r = unsafe { pw_sys::pw_stream_trigger_process(self.as_raw_ptr()) };

        SpaResult::from_c(r).into_result()?;
        Ok(())
    }

    /// Query the time on the stream.
    ///
    /// The time reported by this function is updated every graph cycle, usually
    /// from the process callback. Values such as `ticks` and `delay` are
    /// meaningful when used together with `now`: use `pw_stream_get_nsec()` to
    /// get the current timestamp and interpolate.
    ///
    /// EchoMusic vendor patch: always use `pw_stream_get_time()` so the crate
    /// can compile against distro headers that do not expose
    /// `pw_stream_get_time_n()`.
    ///
    /// This function is RT-safe.
    pub fn time(&self) -> Result<Time, Error> {
        unsafe {
            let mut time = mem::MaybeUninit::<pw_sys::pw_time>::zeroed();

            let r = pw_sys::pw_stream_get_time(self.as_raw_ptr(), time.as_mut_ptr());

            SpaResult::from_c(r).into_result()?;
            Ok(Time(time.assume_init()))
        }
    }

    // TODO: pw_stream_get_core()
    // TODO: pw_stream_get_nsec() (since PipeWire 1.1.0, needs v1_1 feature)
}

type ParamChangedCB<D> = dyn FnMut(&Stream, &mut D, u32, Option<&spa::pod::Pod>);
type ProcessCB<D> = dyn FnMut(&Stream, &mut D);

#[allow(clippy::type_complexity)]
pub struct ListenerLocalCallbacks<D> {
    pub state_changed: Option<Box<dyn FnMut(&Stream, &mut D, StreamState, StreamState)>>,
    pub control_info:
        Option<Box<dyn FnMut(&Stream, &mut D, u32, *const pw_sys::pw_stream_control)>>,
    pub io_changed: Option<Box<dyn FnMut(&Stream, &mut D, u32, *mut os::raw::c_void, u32)>>,
    pub param_changed: Option<Box<ParamChangedCB<D>>>,
    pub add_buffer: Option<Box<dyn FnMut(&Stream, &mut D, *mut pw_sys::pw_buffer)>>,
    pub remove_buffer: Option<Box<dyn FnMut(&Stream, &mut D, *mut pw_sys::pw_buffer)>>,
    pub process: Option<Box<ProcessCB<D>>>,
    pub drained: Option<Box<dyn FnMut(&Stream, &mut D)>>,
    #[cfg(feature = "v0_3_39")]
    pub command: Option<Box<dyn FnMut(&Stream, &mut D, *const spa_sys::spa_command)>>,
    #[cfg(feature = "v0_3_40")]
    pub trigger_done: Option<Box<dyn FnMut(&Stream, &mut D)>>,
    pub user_data: D,
    stream: Option<ptr::NonNull<pw_sys::pw_stream>>,
}

unsafe fn unwrap_stream_ptr<'a>(stream: Option<ptr::NonNull<pw_sys::pw_stream>>) -> &'a Stream {
    stream
        .map(|ptr| ptr.cast::<Stream>().as_ref())
        .expect("stream cannot be null")
}

impl<D> ListenerLocalCallbacks<D> {
    fn with_user_data(user_data: D) -> Self {
        ListenerLocalCallbacks {
            process: Default::default(),
            stream: Default::default(),
            drained: Default::default(),
            add_buffer: Default::default(),
            control_info: Default::default(),
            io_changed: Default::default(),
            param_changed: Default::default(),
            remove_buffer: Default::default(),
            state_changed: Default::default(),
            #[cfg(feature = "v0_3_39")]
            command: Default::default(),
            #[cfg(feature = "v0_3_40")]
            trigger_done: Default::default(),
            user_data,
        }
    }

    pub(crate) fn into_raw(
        self,
    ) -> (
        Pin<Box<pw_sys::pw_stream_events>>,
        Box<ListenerLocalCallbacks<D>>,
    ) {
        let callbacks = Box::new(self);

        unsafe extern "C" fn on_state_changed<D>(
            data: *mut os::raw::c_void,
            old: pw_sys::pw_stream_state,
            new: pw_sys::pw_stream_state,
            error: *const os::raw::c_char,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.state_changed {
                    let stream = unwrap_stream_ptr(state.stream);
                    let old = StreamState::from_raw(old, error);
                    let new = StreamState::from_raw(new, error);
                    cb(stream, &mut state.user_data, old, new)
                };
            }
        }

        unsafe extern "C" fn on_control_info<D>(
            data: *mut os::raw::c_void,
            id: u32,
            control: *const pw_sys::pw_stream_control,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.control_info {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data, id, control);
                }
            }
        }

        unsafe extern "C" fn on_io_changed<D>(
            data: *mut os::raw::c_void,
            id: u32,
            area: *mut os::raw::c_void,
            size: u32,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.io_changed {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data, id, area, size);
                }
            }
        }

        unsafe extern "C" fn on_param_changed<D>(
            data: *mut os::raw::c_void,
            id: u32,
            param: *const spa_sys::spa_pod,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.param_changed {
                    let stream = unwrap_stream_ptr(state.stream);
                    let param = if !param.is_null() {
                        Some(spa::pod::Pod::from_raw(param))
                    } else {
                        None
                    };

                    cb(stream, &mut state.user_data, id, param);
                }
            }
        }

        unsafe extern "C" fn on_add_buffer<D>(
            data: *mut ::std::os::raw::c_void,
            buffer: *mut pw_sys::pw_buffer,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.add_buffer {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data, buffer);
                }
            }
        }

        unsafe extern "C" fn on_remove_buffer<D>(
            data: *mut ::std::os::raw::c_void,
            buffer: *mut pw_sys::pw_buffer,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.remove_buffer {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data, buffer);
                }
            }
        }

        unsafe extern "C" fn on_process<D>(data: *mut ::std::os::raw::c_void) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.process {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data);
                }
            }
        }

        unsafe extern "C" fn on_drained<D>(data: *mut ::std::os::raw::c_void) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.drained {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data);
                }
            }
        }

        #[cfg(feature = "v0_3_39")]
        unsafe extern "C" fn on_command<D>(
            data: *mut ::std::os::raw::c_void,
            command: *const spa_sys::spa_command,
        ) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.command {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data, command);
                }
            }
        }

        #[cfg(feature = "v0_3_40")]
        unsafe extern "C" fn on_trigger_done<D>(data: *mut ::std::os::raw::c_void) {
            if let Some(state) = (data as *mut ListenerLocalCallbacks<D>).as_mut() {
                if let Some(cb) = &mut state.trigger_done {
                    let stream = unwrap_stream_ptr(state.stream);
                    cb(stream, &mut state.user_data);
                }
            }
        }

        let events = unsafe {
            let mut events: Pin<Box<pw_sys::pw_stream_events>> = Box::pin(mem::zeroed());
            events.version = pw_sys::PW_VERSION_STREAM_EVENTS;

            if callbacks.state_changed.is_some() {
                events.state_changed = Some(on_state_changed::<D>);
            }
            if callbacks.control_info.is_some() {
                events.control_info = Some(on_control_info::<D>);
            }
            if callbacks.io_changed.is_some() {
                events.io_changed = Some(on_io_changed::<D>);
            }
            if callbacks.param_changed.is_some() {
                events.param_changed = Some(on_param_changed::<D>);
            }
            if callbacks.add_buffer.is_some() {
                events.add_buffer = Some(on_add_buffer::<D>);
            }
            if callbacks.remove_buffer.is_some() {
                events.remove_buffer = Some(on_remove_buffer::<D>);
            }
            if callbacks.process.is_some() {
                events.process = Some(on_process::<D>);
            }
            if callbacks.drained.is_some() {
                events.drained = Some(on_drained::<D>);
            }
            #[cfg(feature = "v0_3_39")]
            if callbacks.command.is_some() {
                events.command = Some(on_command::<D>);
            }
            #[cfg(feature = "v0_3_40")]
            if callbacks.trigger_done.is_some() {
                events.trigger_done = Some(on_trigger_done::<D>);
            }

            events
        };

        (events, callbacks)
    }
}

/// A builder for registering stream event callbacks.
///
/// Use [`Stream::add_local_listener`] or [`Stream::add_local_listener_with_user_data`] to create this and register callbacks that will be called when events of interest occur.
/// After adding callbacks, use [`register`](Self::register) to get back a [`StreamListener`].
///
/// # Examples
/// ```
/// # use pipewire::stream::Stream;
/// # use pipewire::spa::pod::Pod;
/// # fn example(stream: Stream) {
/// let stream_listener = stream.add_local_listener::<()>()
///     .state_changed(|_stream, _user_data, old, new| println!("Stream state changed from {old:?} to {new:?}"))
///     .control_info(|_stream, _user_data, id, control| println!("Stream control info: id {id}, control {control:?}"))
///     .io_changed(|_stream, _user_data, id, area, size| println!("Stream IO change: IO type {id}, area {area:?}, size {size}"))
///     .param_changed(|_stream, _user_data, id, param| println!("Stream param change: id {id}, param {:?}",
///         param.map(Pod::as_bytes)))
///     .add_buffer(|_stream, _user_data, buffer| println!("Stream buffer added {buffer:?}"))
///     .remove_buffer(|_stream, _user_data, buffer| println!("Stream buffer removed {buffer:?}"))
///     .process(|stream, _user_data| {
///         println!("Stream can be processed");
///         let buf = stream.dequeue_buffer();
///         // Produce or consume data using the buffer
///         // The buffer is enqueued back to the stream when it's dropped
///     })
///     .drained(|_stream, _user_data| println!("Stream is drained"))
///     .register();
/// # }
/// ```
pub struct ListenerLocalBuilder<'a, D> {
    stream: &'a Stream,
    callbacks: ListenerLocalCallbacks<D>,
}

impl<'a, D> ListenerLocalBuilder<'a, D> {
    /// Set the stream `state_changed` event callback of the listener.
    ///
    /// This event is emitted when the stream state changes.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `data`: User data
    /// `old`: Old stream state
    /// `new`: New stream state
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .state_changed(|_stream, _user_data, old, new| println!("Stream state changed from {old:?} to {new:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn state_changed<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, StreamState, StreamState) + 'static,
    {
        self.callbacks.state_changed = Some(Box::new(callback));
        self
    }

    /// Set the stream `control_info` event callback of the listener.
    ///
    /// This event is emitted when there is information about a control.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    /// `id`: Type of the control
    /// `control`: The control
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .control_info(|_stream, _user_data, id, _control| println!("Stream control info {id}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn control_info<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, u32, *const pw_sys::pw_stream_control) + 'static,
    {
        self.callbacks.control_info = Some(Box::new(callback));
        self
    }

    /// Set the stream `io_changed` event callback of the listener.
    ///
    /// This event is emitted when IO is changed on the stream.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    /// `id`: Type of the IO area
    /// `area`: The IO area
    /// `size`: The IO area size
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .io_changed(|_stream, _user_data, id, _area, size| println!("Stream IO change: IO type {id}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn io_changed<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, u32, *mut os::raw::c_void, u32) + 'static,
    {
        self.callbacks.io_changed = Some(Box::new(callback));
        self
    }

    /// Set the stream `param_changed` event callback of the listener.
    ///
    /// This event is emitted when a param is changed.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    /// `id`: Type of the param
    /// `param`: The param
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # use pipewire::spa::pod::Pod;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .param_changed(|_stream, _user_data, id, param| println!("Stream param change: id {id}, param {:?}",
    ///         param.map(Pod::as_bytes)))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn param_changed<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, u32, Option<&spa::pod::Pod>) + 'static,
    {
        self.callbacks.param_changed = Some(Box::new(callback));
        self
    }

    /// Set the stream `add_buffer` event callback of the listener.
    ///
    /// This event is emitted when a buffer was added for this stream.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    /// `buffer`: The buffer
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .add_buffer(|_stream, _user_data, buffer| println!("Stream buffer added {buffer:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn add_buffer<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, *mut pw_sys::pw_buffer) + 'static,
    {
        self.callbacks.add_buffer = Some(Box::new(callback));
        self
    }

    /// Set the stream `remove_buffer` event callback of the listener.
    ///
    /// This event is emitted when a buffer was removed for this stream.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    /// `buffer`: The buffer
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .remove_buffer(|_stream, _user_data, buffer| println!("Stream buffer removed {buffer:?}"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn remove_buffer<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D, *mut pw_sys::pw_buffer) + 'static,
    {
        self.callbacks.remove_buffer = Some(Box::new(callback));
        self
    }

    /// Set the stream `process` event callback of the listener.
    ///
    /// This event is emitted when a buffer can be queued (for playback streams) or dequeued (for capture streams).
    ///
    /// This is normally called from the mainloop but can also be called directly from the realtime data thread if the user is prepared to deal with this.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .process(|stream, _user_data| {
    ///         println!("Stream can be processed");
    ///         let buf = stream.dequeue_buffer();
    ///         // Produce or consume data using the buffer
    ///         // The buffer is enqueued back to the stream when it's dropped
    ///     })
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn process<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D) + 'static,
    {
        self.callbacks.process = Some(Box::new(callback));
        self
    }

    /// Set the stream `drained` event callback of the listener.
    ///
    /// This event is emitted when the stream is drained.
    ///
    /// # Callback parameters
    /// `stream`: The stream
    /// `user_data`: User data
    ///
    /// # Examples
    /// ```
    /// # use pipewire::stream::Stream;
    /// # fn example(stream: Stream) {
    /// let stream_listener = stream.add_local_listener::<()>()
    ///     .drained(|_stream, _user_data| println!("Stream is drained"))
    ///     .register();
    /// # }
    /// ```
    #[must_use = "Call `.register()` to start receiving events"]
    pub fn drained<F>(mut self, callback: F) -> Self
    where
        F: FnMut(&Stream, &mut D) + 'static,
    {
        self.callbacks.drained = Some(Box::new(callback));
        self
    }

    /// Subscribe to events and register any provided callbacks.
    pub fn register(self) -> Result<StreamListener<D>, Error> {
        let (events, data) = self.callbacks.into_raw();
        let (listener, data) = unsafe {
            let listener: Box<spa_sys::spa_hook> = Box::new(mem::zeroed());
            let raw_listener = Box::into_raw(listener);
            let raw_data = Box::into_raw(data);
            pw_sys::pw_stream_add_listener(
                self.stream.as_raw_ptr(),
                raw_listener,
                events.as_ref().get_ref(),
                raw_data as *mut _,
            );
            (Box::from_raw(raw_listener), Box::from_raw(raw_data))
        };
        Ok(StreamListener {
            listener,
            _events: events,
            _data: data,
        })
    }
}

/// An owned listener for stream events.
///
/// This is created by [`stream::ListenerLocalBuilder`][ListenerLocalBuilder] and will receive events as long as it is alive.
/// When this gets dropped, the listener gets unregistered and no events will be received by it.
#[must_use = "Listeners unregister themselves when dropped. Keep the listener alive in order to receive events."]
pub struct StreamListener<D> {
    listener: Box<spa_sys::spa_hook>,
    // Need to stay allocated while the listener is registered
    _events: Pin<Box<pw_sys::pw_stream_events>>,
    _data: Box<ListenerLocalCallbacks<D>>,
}

impl<D> StreamListener<D> {
    /// Stop the listener from receiving any events
    ///
    /// Removes the listener registration and cleans up allocated resources.
    pub fn unregister(self) {
        // do nothing, drop will clean up.
    }
}

impl<D> std::ops::Drop for StreamListener<D> {
    fn drop(&mut self) {
        spa::utils::hook::remove(*self.listener);
    }
}

bitflags! {
    /// Extra flags that can be used in [`Stream::connect()`]
    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    pub struct StreamFlags: pw_sys::pw_stream_flags {
        const AUTOCONNECT = pw_sys::pw_stream_flags_PW_STREAM_FLAG_AUTOCONNECT;
        const INACTIVE = pw_sys::pw_stream_flags_PW_STREAM_FLAG_INACTIVE;
        const MAP_BUFFERS = pw_sys::pw_stream_flags_PW_STREAM_FLAG_MAP_BUFFERS;
        const DRIVER = pw_sys::pw_stream_flags_PW_STREAM_FLAG_DRIVER;
        const RT_PROCESS = pw_sys::pw_stream_flags_PW_STREAM_FLAG_RT_PROCESS;
        const NO_CONVERT = pw_sys::pw_stream_flags_PW_STREAM_FLAG_NO_CONVERT;
        const EXCLUSIVE = pw_sys::pw_stream_flags_PW_STREAM_FLAG_EXCLUSIVE;
        const DONT_RECONNECT = pw_sys::pw_stream_flags_PW_STREAM_FLAG_DONT_RECONNECT;
        const ALLOC_BUFFERS = pw_sys::pw_stream_flags_PW_STREAM_FLAG_ALLOC_BUFFERS;
        #[cfg(feature = "v0_3_41")]
        const TRIGGER = pw_sys::pw_stream_flags_PW_STREAM_FLAG_TRIGGER;
    }
}
