mod cursor;
mod decoder;
mod demuxer;
mod engine;
pub mod io;
mod packet_cache;

pub(crate) use decoder::Decoder;
pub(crate) use demuxer::Demuxer;
pub(crate) use engine::DecodeEngine;
pub use engine::ScanMode;
pub(crate) use packet_cache::PacketCache;
pub use packet_cache::{PacketCacheOptions, PacketCacheSeekableRange, PacketCacheStats};

/// Specifies the precision mode used during stream seeking operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SeekMode {
    /// Fast seek to a position near the target time where decoding can start.
    ///
    /// The decoder is flushed to prevent audio glitches, but no sample-level
    /// trimming is performed. The first frame usually starts slightly before the
    /// target; where the container cannot reach positions before the target, it
    /// starts slightly after it.
    #[default]
    Coarse,

    /// Sample-level accurate seek.
    ///
    /// Incurs decoding overhead to exactly align with the target time: the first
    /// delivered sample is the first sample at or after the target that the
    /// container can reach, and excess samples at the beginning of its frame are
    /// trimmed. Where the container cannot reach positions before the target (for
    /// example near the start of some Matroska files), delivery starts at the
    /// nearest reachable position after the target, and the frame's timestamp
    /// reports that position.
    Accurate,
}
