// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::{
    ffi::{CStr, CString},
    ops::Deref,
    ptr,
    rc::{Rc, Weak},
};

use crate::{
    core::CoreRc,
    properties::PropertiesBox,
    stream::{Stream, StreamBox},
    Error,
};

#[derive(Debug)]
struct StreamRcInner {
    stream: StreamBox<'static>,
    // Store the core here, so that the core is not dropped before the stream,
    // which may lead to undefined behaviour. Rusts drop order of struct fields
    // (from top to bottom) ensures that this is always destroyed _after_ the context.
    _core: CoreRc,
}

/// Reference counting smart pointer providing shared ownership of a PipeWire [stream](super).
///
/// For the non-owning variant, see [`StreamWeak`].
/// For unique ownership, see [`StreamBox`].
///
/// For an explanation of these, see [Smart pointers to PipeWire objects](crate#smart-pointers-to-pipewire-objects).
#[derive(Clone, Debug)]
pub struct StreamRc {
    inner: Rc<StreamRcInner>,
}

impl StreamRc {
    pub fn new(core: CoreRc, name: &str, properties: PropertiesBox) -> Result<StreamRc, Error> {
        let name = CString::new(name).expect("Invalid byte in stream name");

        let c_str = name.as_c_str();
        StreamRc::new_cstr(core, c_str, properties)
    }

    /// Initialises a new stream with the given `name` as C String and `properties`.
    pub fn new_cstr(
        core: CoreRc,
        name: &CStr,
        properties: PropertiesBox,
    ) -> Result<StreamRc, Error> {
        unsafe {
            let stream =
                pw_sys::pw_stream_new(core.as_raw_ptr(), name.as_ptr(), properties.into_raw());
            let stream = ptr::NonNull::new(stream).ok_or(Error::CreationFailed)?;

            let stream: StreamBox<'static> = StreamBox::from_raw(stream);

            Ok(Self {
                inner: Rc::new(StreamRcInner {
                    stream,
                    _core: core,
                }),
            })
        }
    }

    pub fn downgrade(&self) -> StreamWeak {
        let weak = Rc::downgrade(&self.inner);
        StreamWeak { weak }
    }
}

impl std::ops::Deref for StreamRc {
    type Target = Stream;

    fn deref(&self) -> &Self::Target {
        self.inner.stream.deref()
    }
}

impl std::convert::AsRef<Stream> for StreamRc {
    fn as_ref(&self) -> &Stream {
        self.deref()
    }
}

/// Non-owning reference to a [stream](super) managed by [`StreamRc`].
///
/// The stream can be accessed by calling [`upgrade`](Self::upgrade).
pub struct StreamWeak {
    weak: Weak<StreamRcInner>,
}

impl StreamWeak {
    pub fn upgrade(&self) -> Option<StreamRc> {
        self.weak.upgrade().map(|inner| StreamRc { inner })
    }
}
