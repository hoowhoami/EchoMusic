use std::ffi::CStr;

use crate::{
    decode::{
        Decoder,
        Demuxer,
    },
    sys,
};

#[derive(Debug, Clone)]
pub struct AudioStreamInfo {
    pub ordinal: usize,
    pub stream_index: usize,
    pub selected: bool,
    pub codec_name: Option<String>,
    pub title: Option<String>,
    pub lang: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SourceAudioInfo {
    /// Samples per second.
    pub sample_rate: i32,

    /// Number of channels.
    pub channels: i32,

    /// The average bitrate of the encoded data (in bits per second).
    pub bit_rate: i64,

    /// Audio sample format.
    pub sample_fmt: Option<String>,

    /// The name of a codec.
    pub codec_name: Option<String>,

    /// This is the number of valid bits in each output sample.
    ///
    /// If the sample format has more bits, the least significant bits are additional
    /// padding bits, which are always `0`. Use right shifts to reduce the sample
    /// to its actual size. For example, audio formats with 24 bit samples will
    /// have `bits_per_raw_sample` set to `24`, and format set to `AV_SAMPLE_FMT_S32`.
    ///
    /// To get the original sample use `(int32_t)sample >> 8`.
    ///
    /// For ADPCM this might be `12` or `16` or similar
    ///
    /// Can be 0
    pub bits_per_sample: i32,
}

impl SourceAudioInfo {
    pub(crate) fn probe_parts(demuxer: &Demuxer, decoder: &Decoder) -> Self {
        unsafe {
            let codec_params = demuxer.stream_codec_params();

            let codec_id = (*codec_params).codec_id;
            let codec_name_ptr = sys::avcodec_get_name(codec_id);
            let codec_name = if codec_name_ptr.is_null() {
                None
            } else {
                Some(
                    CStr::from_ptr(codec_name_ptr)
                        .to_string_lossy()
                        .into_owned(),
                )
            };

            let src_sample_fmt = decoder.sample_fmt();
            let fmt_name_ptr = sys::av_get_sample_fmt_name(src_sample_fmt);
            let sample_fmt_str = if fmt_name_ptr.is_null() {
                None
            } else {
                Some(CStr::from_ptr(fmt_name_ptr).to_string_lossy().into_owned())
            };

            let stream_bit_rate = (*codec_params).bit_rate;
            let bit_rate = if stream_bit_rate > 0 {
                stream_bit_rate
            } else {
                demuxer.bit_rate()
            };

            let bits_per_raw = (*codec_params).bits_per_raw_sample;
            let bits_per_coded = (*codec_params).bits_per_coded_sample;
            let bits_per_sample = if bits_per_raw > 0 {
                bits_per_raw
            } else {
                bits_per_coded
            };

            Self {
                sample_rate: decoder.sample_rate(),
                channels: decoder.channels(),
                bit_rate,
                sample_fmt: sample_fmt_str,
                codec_name,
                bits_per_sample,
            }
        }
    }
}
