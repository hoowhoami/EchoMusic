use crate::buffer::CapturedSamples;
use rubato::{FftFixedInOut, Resampler};

pub const FORMAT_F32_LE: &str = "f32le";
pub const FORMAT_S16_LE: &str = "s16le";

pub struct ConvertedAudio {
    pub data: Vec<u8>,
    pub sample_rate: u32,
    pub channels: usize,
    pub sample_format: &'static str,
    pub frames: usize,
}

pub fn convert(
    captured: CapturedSamples,
    output_rate: Option<u32>,
    output_channels: Option<u32>,
    output_format: Option<&str>,
) -> Result<ConvertedAudio, String> {
    if captured.sample_rate == 0 || captured.channels == 0 {
        return Err("audio capture returned an invalid format".to_string());
    }
    if captured.samples.is_empty() {
        return Err("audio capture returned no samples".to_string());
    }

    let sample_rate = output_rate.unwrap_or(captured.sample_rate);
    if !(4_000..=384_000).contains(&sample_rate) {
        return Err(format!("unsupported output sample rate: {sample_rate}"));
    }
    let channels = output_channels.unwrap_or(captured.channels as u32) as usize;
    if !(1..=8).contains(&channels) {
        return Err(format!("unsupported output channel count: {channels}"));
    }
    let requested_format = output_format.unwrap_or(FORMAT_F32_LE).to_ascii_lowercase();
    let sample_format = match requested_format.as_str() {
        FORMAT_F32_LE => FORMAT_F32_LE,
        FORMAT_S16_LE => FORMAT_S16_LE,
        other => return Err(format!("unsupported output sample format: {other}")),
    };

    let channel_converted = convert_channels(&captured.samples, captured.channels, channels);
    let converted = if sample_rate == captured.sample_rate {
        channel_converted
    } else {
        resample_interleaved(
            &channel_converted,
            captured.sample_rate,
            sample_rate,
            channels,
        )?
    };
    if converted.is_empty() {
        return Err("captured audio is too short for the requested output format".to_string());
    }
    let frames = converted.len() / channels;
    let data = encode(&converted, sample_format);

    Ok(ConvertedAudio {
        data,
        sample_rate,
        channels,
        sample_format,
        frames,
    })
}

fn convert_channels(input: &[f32], input_channels: usize, output_channels: usize) -> Vec<f32> {
    if input_channels == output_channels {
        return input.to_vec();
    }

    let frames = input.len() / input_channels;
    let mut output = Vec::with_capacity(frames * output_channels);
    for frame in input.chunks_exact(input_channels) {
        if output_channels == 1 {
            output.push(frame.iter().sum::<f32>() / input_channels as f32);
        } else if input_channels == 1 {
            output.extend(std::iter::repeat_n(frame[0], output_channels));
        } else {
            for channel in 0..output_channels {
                output.push(frame[channel.min(input_channels - 1)]);
            }
        }
    }
    output
}

fn resample_interleaved(
    input: &[f32],
    input_rate: u32,
    output_rate: u32,
    channels: usize,
) -> Result<Vec<f32>, String> {
    let input_frames = input.len() / channels;
    let mut planar = vec![Vec::with_capacity(input_frames); channels];
    for frame in input.chunks_exact(channels) {
        for (channel, sample) in frame.iter().enumerate() {
            planar[channel].push(*sample);
        }
    }

    let mut resampler =
        FftFixedInOut::<f32>::new(input_rate as usize, output_rate as usize, 1_024, channels)
            .map_err(|err| format!("failed to create audio resampler: {err}"))?;
    let delay = resampler.output_delay();
    let chunk_size = resampler.input_frames_next();
    let expected_frames = ((input_frames as u64 * output_rate as u64 + input_rate as u64 / 2)
        / input_rate as u64) as usize;
    let mut output_planar = vec![Vec::new(); channels];
    let mut offset = 0usize;

    while offset + chunk_size <= input_frames {
        let input_chunk = planar
            .iter()
            .map(|channel| &channel[offset..offset + chunk_size])
            .collect::<Vec<_>>();
        append_planar(
            &mut output_planar,
            resampler
                .process(&input_chunk, None)
                .map_err(|err| format!("failed to resample captured audio: {err}"))?,
        );
        offset += chunk_size;
    }

    if offset < input_frames {
        let input_chunk = planar
            .iter()
            .map(|channel| &channel[offset..])
            .collect::<Vec<_>>();
        append_planar(
            &mut output_planar,
            resampler
                .process_partial(Some(&input_chunk), None)
                .map_err(|err| format!("failed to flush partial system audio: {err}"))?,
        );
    }
    append_planar(
        &mut output_planar,
        resampler
            .process_partial::<&[f32]>(None, None)
            .map_err(|err| format!("failed to flush audio resampler: {err}"))?,
    );

    let available_frames = output_planar
        .iter()
        .map(Vec::len)
        .min()
        .unwrap_or(0)
        .saturating_sub(delay)
        .min(expected_frames);
    let mut output = Vec::with_capacity(available_frames * channels);
    for frame in 0..available_frames {
        for channel in &output_planar {
            output.push(channel[delay + frame]);
        }
    }
    Ok(output)
}

fn append_planar(target: &mut [Vec<f32>], source: Vec<Vec<f32>>) {
    for (target_channel, mut source_channel) in target.iter_mut().zip(source) {
        target_channel.append(&mut source_channel);
    }
}

fn encode(samples: &[f32], format: &str) -> Vec<u8> {
    match format {
        FORMAT_S16_LE => {
            let mut data = Vec::with_capacity(samples.len() * 2);
            for sample in samples {
                let clamped = sample.clamp(-1.0, 1.0);
                let value = if clamped < 0.0 {
                    (clamped * 32_768.0).round() as i16
                } else {
                    (clamped * 32_767.0).round() as i16
                };
                data.extend_from_slice(&value.to_le_bytes());
            }
            data
        }
        _ => {
            let mut data = Vec::with_capacity(samples.len() * 4);
            for sample in samples {
                data.extend_from_slice(&sample.to_le_bytes());
            }
            data
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{convert, FORMAT_F32_LE, FORMAT_S16_LE};
    use crate::buffer::CapturedSamples;

    #[test]
    fn preserves_source_format_by_default() {
        let result = convert(
            CapturedSamples {
                samples: vec![0.25, -0.25, 0.5, -0.5],
                sample_rate: 48_000,
                channels: 2,
            },
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(result.sample_rate, 48_000);
        assert_eq!(result.channels, 2);
        assert_eq!(result.sample_format, FORMAT_F32_LE);
        assert_eq!(result.frames, 2);
        assert_eq!(result.data.len(), 16);
    }

    #[test]
    fn produces_recognition_format_on_request() {
        let result = convert(
            CapturedSamples {
                samples: vec![0.25; 48_000 * 2],
                sample_rate: 48_000,
                channels: 2,
            },
            Some(8_000),
            Some(1),
            Some(FORMAT_S16_LE),
        )
        .unwrap();
        assert_eq!(result.sample_rate, 8_000);
        assert_eq!(result.channels, 1);
        assert_eq!(result.sample_format, FORMAT_S16_LE);
        assert_eq!(result.frames, 8_000);
        assert_eq!(result.data.len(), 16_000);
    }
}
