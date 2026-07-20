mod decoder;
mod demuxer;
mod engine;
pub mod io;

pub(crate) use decoder::Decoder;
pub(crate) use demuxer::{
    Demuxer,
    PacketCache,
};
pub use demuxer::PacketCacheOptions;
pub(crate) use engine::DecodeEngine;
pub use engine::ScanMode;

/// Specifies the precision mode used during stream seeking operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeekMode {
    /// Fast seek to the nearest keyframe preceding the target time.
    ///
    /// The decoder is flushed to prevent audio glitches, but no sample-level
    /// trimming is performed. The returned audio frame's timestamp may be
    /// slightly earlier than the requested target.
    #[default]
    Coarse,

    /// Sample-level accurate seek.
    ///
    /// Incurs decoding overhead to exactly align with the target time.
    /// Excess samples at the beginning of the first frame are trimmed,
    /// and the output timestamp will strictly match the target time.
    Accurate,
}
