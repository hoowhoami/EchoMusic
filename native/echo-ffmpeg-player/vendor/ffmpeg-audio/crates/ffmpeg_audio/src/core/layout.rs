use std::mem;

use crate::{
    error::{
        FfErrorExt,
        Result,
    },
    sys,
};

/// A RAII wrapper for FFmpeg's `AVChannelLayout`.
///
/// Ensures safe deep-copying and automatic cleanup of dynamically
/// allocated layout data to prevent memory leaks.
pub struct ChannelLayout(sys::AVChannelLayout);

// Safety: ChannelLayout uniquely owns the underlying AVChannelLayout memory
// (via copy/uninit matching), and FFmpeg-side allocation/deallocation is thread-safe.
unsafe impl Send for ChannelLayout {}

// Safety: Data access methods (including av_channel_layout_compare) are
// side-effect-free, read-only on the FFmpeg side, and involve no interior mutability.
unsafe impl Sync for ChannelLayout {}

impl ChannelLayout {
    /// Creates a default channel layout based on the number of channels.
    pub fn from_default(channels: i32) -> Self {
        unsafe {
            let mut layout = mem::zeroed::<sys::AVChannelLayout>();
            sys::av_channel_layout_default(&raw mut layout, channels);
            Self(layout)
        }
    }

    /// Safely creates a deep copy of an existing `AVChannelLayout`.
    ///
    /// Returns an error if FFmpeg fails to allocate memory for the copy.
    pub fn from_existing(layout_ptr: *const sys::AVChannelLayout) -> Result<Self> {
        unsafe {
            let mut layout = mem::zeroed::<sys::AVChannelLayout>();
            sys::av_channel_layout_copy(&raw mut layout, layout_ptr).into_ff_result()?;
            Ok(Self(layout))
        }
    }

    /// Returns a raw pointer to the underlying `AVChannelLayout` for FFI calls.
    pub const fn as_ptr(&self) -> *const sys::AVChannelLayout {
        &raw const self.0
    }

    /// Returns a safe reference to the underlying `AVChannelLayout`.
    pub const fn as_layout(&self) -> &sys::AVChannelLayout {
        &self.0
    }

    /// Returns the number of channels in this layout.
    pub const fn channels(&self) -> usize {
        self.0.nb_channels as usize
    }

    /// Compares this layout with a raw FFmpeg layout pointer.
    pub fn is_identical_to(&self, other_ptr: *const sys::AVChannelLayout) -> bool {
        unsafe { sys::av_channel_layout_compare(self.as_ptr(), other_ptr) == 0 }
    }
}

impl Drop for ChannelLayout {
    fn drop(&mut self) {
        unsafe {
            sys::av_channel_layout_uninit(&raw mut self.0);
        }
    }
}
