use napi_derive::napi;

pub const MIX_CHANNELS: usize = 2;

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AudioOutputStats {
    pub backend: String,
    pub sample_rate: f64,
    pub engine_sample_rate: f64,
    pub channels: f64,
    pub format: String,
    pub buffer_frames: f64,
    pub buffer_secs: f64,
    pub delay_secs: f64,
    pub underruns: f64,
}

#[napi(object)]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PacketCacheStats {
    pub forward_bytes: f64,
    pub back_bytes: f64,
    pub total_bytes: f64,
    pub forward_secs: Option<f64>,
    pub seekable_start_secs: Option<f64>,
    pub seekable_end_secs: Option<f64>,
    pub eof: bool,
    pub pending_seek: bool,
    pub has_error: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrackSwitchInfo {
    pub url: String,
    pub audio_stream_ordinal: Option<usize>,
    pub seq: u64,
    pub duration: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlaybackSignal {
    TimeUpdate,
    Seeked,
    CacheState {
        paused: bool,
        buffering_state: f64,
        buffered_secs: f64,
        target_secs: f64,
        packet_cache: Option<PacketCacheStats>,
    },
    PacketCacheStats(PacketCacheStats),
    OutputStats(AudioOutputStats),
    TrackSwitch(TrackSwitchInfo),
    PlaybackEnd,
    Stop,
}

#[derive(Debug, PartialEq)]
pub enum FilterInput {
    Frame(DecodedAudioChunk),
    Boundary,
    Eof,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PendingDecodeSeek {
    pub position_secs: f64,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioSampleFormat {
    Unknown = 0,
    U8 = 1,
    S16 = 2,
    S32 = 3,
    F32 = 4,
    F64 = 5,
}

impl AudioSampleFormat {
    pub(crate) fn from_u32(value: u32) -> Self {
        match value {
            1 => Self::U8,
            2 => Self::S16,
            3 => Self::S32,
            4 => Self::F32,
            5 => Self::F64,
            _ => Self::Unknown,
        }
    }

    pub fn best_output_formats(self) -> Vec<Self> {
        let source_format = if self == Self::Unknown {
            Self::S16
        } else {
            self
        };
        let mut scored = [Self::U8, Self::S16, Self::S32, Self::F32, Self::F64]
            .into_iter()
            .enumerate()
            .filter_map(|(index, format)| {
                let score = format.conversion_score_from(source_format);
                (score > i32::MIN).then_some((format, score, index))
            })
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.2.cmp(&right.2)));
        scored.into_iter().map(|(format, _, _)| format).collect()
    }

    pub fn conversion_score_from(self, source_format: Self) -> i32 {
        if self == Self::Unknown || source_format == Self::Unknown {
            return i32::MIN;
        }
        if self == source_format {
            return 1024;
        }
        let mut score = 1024i32;
        if self.is_float() != source_format.is_float() {
            let dst_bytes = self.bytes();
            if self.is_float() {
                let bytes = if dst_bytes == 4 { 3 } else { 6 } - source_format.bytes();
                if bytes >= 0 {
                    score -= 8 * bytes;
                } else {
                    score += 1024 * (bytes - 1);
                }
            } else {
                score -= 1_048_576 * (8 - dst_bytes);
            }
            score -= 512;
        } else {
            let bytes = self.bytes() - source_format.bytes();
            if bytes > 0 {
                score -= 8 * bytes;
            } else if bytes < 0 {
                score += 1024 * (bytes - 1);
            }
        }
        score
    }

    pub fn is_float(self) -> bool {
        matches!(self, Self::F32 | Self::F64)
    }

    pub fn bytes(self) -> i32 {
        match self {
            Self::U8 => 1,
            Self::S16 => 2,
            Self::S32 | Self::F32 => 4,
            Self::F64 => 8,
            Self::Unknown => 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MixFormat {
    pub sample_rate: u32,
    pub sample_format: AudioSampleFormat,
    pub channels: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodedAudioFormat {
    pub sample_rate: u32,
    pub sample_format: AudioSampleFormat,
    pub channels: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DecodedAudioData {
    U8(Vec<u8>),
    I16(Vec<i16>),
    I32(Vec<i32>),
    F32(Vec<f32>),
    F64(Vec<f64>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct DecodedAudioChunk {
    pub format: DecodedAudioFormat,
    pub frames: usize,
    pub pts_secs: Option<f64>,
    pub data: DecodedAudioData,
}

impl DecodedAudioChunk {
    pub fn new(
        format: DecodedAudioFormat,
        frames: usize,
        pts_secs: Option<f64>,
        data: DecodedAudioData,
    ) -> Self {
        Self {
            format,
            frames,
            pts_secs,
            data,
        }
    }

    pub(crate) fn estimated_mix_frames(&self, mix_sample_rate: u32) -> usize {
        if self.format.sample_rate == 0 || mix_sample_rate == self.format.sample_rate {
            return self.frames;
        }
        ((self.frames as u128 * mix_sample_rate as u128) / self.format.sample_rate as u128) as usize
    }
}

impl MixFormat {
    pub fn f32(sample_rate: u32, channels: usize) -> Self {
        Self {
            sample_rate,
            sample_format: AudioSampleFormat::F32,
            channels: channels.max(1),
        }
    }

    pub fn stereo_f32(sample_rate: u32) -> Self {
        Self::f32(sample_rate, MIX_CHANNELS)
    }
}
