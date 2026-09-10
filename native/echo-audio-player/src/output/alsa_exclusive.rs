use super::cpal_shared::OutputResampler;
use crate::device::platform_linux::resolve_alsa_exclusive_device_name;
use crate::events::{PlayerErrorCode, PlayerEvent};
use crate::output::{
    build_output_stats, emit_output_runtime_error, fill_output_reusing,
    output_buffer_mode_for_frames, output_start_was_cancelled, report_output_start,
    report_output_start_failure, OutputStartSender, OutputStopToken,
};
use crate::shared::{AudioSampleFormat, SharedAudio, MIX_CHANNELS};
use alsa::pcm::{Access, Format, HwParams, State, PCM};
use alsa::{Direction, Error, ValueOr};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const ALSA_BUFFER_TIME_US: u32 = 100_000;
const ALSA_PERIODS: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AlsaSampleFormat {
    F32,
    F64,
    I32,
    I24In32,
    I24,
    I16,
    U8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AlsaOutputFormat {
    sample_format: AlsaSampleFormat,
    sample_rate: u32,
    channels: usize,
    period_frames: usize,
    buffer_frames: usize,
    can_pause: bool,
}

pub(crate) fn probe_output(device_name: &str, sample_rate: u32) -> Result<(), String> {
    let pcm = open_pcm(device_name)?;
    configure_pcm(
        &pcm,
        sample_rate,
        MIX_CHANNELS,
        AudioSampleFormat::Unknown,
        f64::from(ALSA_BUFFER_TIME_US) / 1_000_000.0,
    )
    .map(|_| ())
}

pub fn spawn_output_thread(
    device_name: String,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: Option<OutputStartSender>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut start_notify = start_notify;
        match run_exclusive_output(
            &device_name,
            shared.clone(),
            stop.clone(),
            emit,
            &mut start_notify,
        ) {
            Ok(()) => {}
            Err(message) => {
                let startup_failure =
                    report_output_start_failure(&mut start_notify, message.clone());
                if !startup_failure {
                    emit_output_runtime_error(
                        &shared,
                        &stop,
                        emit,
                        PlayerErrorCode::OutputExclusive,
                        message,
                    );
                } else {
                    stop.request_stop();
                }
            }
        }
    })
}

fn run_exclusive_output(
    device_name: &str,
    shared: Arc<SharedAudio>,
    stop: OutputStopToken,
    emit: fn(PlayerEvent),
    start_notify: &mut Option<OutputStartSender>,
) -> Result<(), String> {
    let resolved = resolve_alsa_exclusive_device_name(device_name).ok_or_else(|| {
        format!("ALSA hardware output is not available for exclusive mode: {device_name}")
    })?;
    let pcm = open_pcm(&resolved)?;
    let preferred_output_format = shared.preferred_output_sample_format();
    let format = configure_pcm(
        &pcm,
        shared.mix_format.sample_rate,
        shared.mix_format.channels,
        preferred_output_format,
        shared.requested_output_buffer_secs(),
    )?;
    let device_buffer_secs = format.buffer_frames as f64 / f64::from(format.sample_rate.max(1));
    shared.update_output_stats(build_output_stats(
        "alsa-exclusive",
        &shared,
        format.sample_rate,
        format.channels,
        format!("{:?}", format.sample_format),
        output_buffer_mode_for_frames(format.buffer_frames.min(u32::MAX as usize) as u32),
        format.buffer_frames as f64,
        device_buffer_secs,
    ));
    emit(PlayerEvent::log(
        "info",
        format!(
            "ALSA exclusive opening: requested='{device_name}', resolved='{resolved}', sample_rate={}, engine_sample_rate={}, channels={}, preferred_output_format={:?}, format={:?}, period_frames={}, buffer_frames={}",
            format.sample_rate,
            shared.mix_format.sample_rate,
            format.channels,
            preferred_output_format,
            format.sample_format,
            format.period_frames,
            format.buffer_frames
        ),
    ));
    if output_start_was_cancelled(&stop, &shared, start_notify) {
        return Ok(());
    }
    shared.mark_output_started();
    report_output_start(start_notify, Ok(()));

    let realtime_samples = format.period_frames.saturating_mul(format.channels.max(1));
    let graph_samples = format
        .period_frames
        .saturating_mul(shared.mix_format.channels.max(1));
    let mut output_scratch = Vec::<f32>::with_capacity(realtime_samples);
    let mut stereo_scratch = Vec::<f32>::with_capacity(graph_samples);
    let mut converted_i16 = Vec::<i16>::with_capacity(realtime_samples);
    let mut converted_i32 = Vec::<i32>::with_capacity(realtime_samples);
    let mut converted_i24 = Vec::<u8>::with_capacity(realtime_samples.saturating_mul(3));
    let mut converted_u8 = Vec::<u8>::with_capacity(realtime_samples);
    let mut converted_f64 = Vec::<f64>::with_capacity(realtime_samples);
    let mut resampler = OutputResampler::new(
        shared.mix_format.sample_rate,
        format.sample_rate,
        shared.mix_format.channels,
        format.channels,
    )?;
    resampler.reserve_realtime_capacity(format.period_frames)?;
    let mut paused = false;

    while !stop.should_stop(&shared) {
        if shared.paused.load(std::sync::atomic::Ordering::Acquire) {
            if !paused {
                pause_pcm(&pcm, &format);
                paused = true;
            }
            thread::sleep(Duration::from_millis(20));
            continue;
        }
        if paused {
            resume_pcm(&pcm);
            paused = false;
        }

        recover_pcm_state(&pcm)?;
        let samples = format.period_frames.saturating_mul(format.channels);
        output_scratch.resize(samples, 0.0);
        if format.sample_rate == shared.mix_format.sample_rate
            && format.channels == shared.mix_format.channels
        {
            fill_output_reusing(
                &mut output_scratch,
                format.channels,
                &shared,
                &mut stereo_scratch,
            );
        } else {
            resampler.fill_output(&mut output_scratch, format.channels, &shared);
        }

        write_frames(
            &pcm,
            &format,
            &output_scratch,
            &mut converted_i16,
            &mut converted_i32,
            &mut converted_i24,
            &mut converted_u8,
            &mut converted_f64,
            &stop,
            &shared,
        )?;
        if stop.should_stop(&shared) {
            break;
        }
        if pcm.state() != State::Running {
            let _ = pcm.start();
        }
    }

    let _ = pcm.drop();
    Ok(())
}

fn open_pcm(device_name: &str) -> Result<PCM, String> {
    PCM::new(device_name, Direction::Playback, true)
        .map_err(|err| format!("failed to open ALSA exclusive output '{device_name}': {err}"))
}

fn configure_pcm(
    pcm: &PCM,
    sample_rate: u32,
    channels: usize,
    source_format: AudioSampleFormat,
    requested_buffer_secs: f64,
) -> Result<AlsaOutputFormat, String> {
    let hwp = HwParams::any(pcm).map_err(|err| format!("failed to query ALSA hw params: {err}"))?;
    hwp.set_rate_resample(false)
        .map_err(|err| format!("failed to disable ALSA resampling: {err}"))?;
    hwp.set_access(Access::RWInterleaved)
        .map_err(|err| format!("failed to set ALSA interleaved access: {err}"))?;
    let sample_format = choose_sample_format(&hwp, source_format)?;
    hwp.set_channels_near(channels.max(1) as u32)
        .map_err(|err| format!("failed to set ALSA output channels: {err}"))?;
    let actual_rate = hwp
        .set_rate_near(sample_rate, ValueOr::Nearest)
        .map_err(|err| format!("failed to set ALSA output sample rate: {err}"))?;
    let _ = hwp.set_buffer_time_near(
        alsa_requested_buffer_time_us(requested_buffer_secs),
        ValueOr::Nearest,
    );
    let _ = hwp.set_periods(ALSA_PERIODS, ValueOr::Nearest);
    pcm.hw_params(&hwp)
        .map_err(|err| format!("failed to apply ALSA hw params: {err}"))?;

    let hwp = pcm
        .hw_params_current()
        .map_err(|err| format!("failed to read ALSA active hw params: {err}"))?;
    let period_frames = hwp
        .get_period_size()
        .map_err(|err| format!("failed to read ALSA period size: {err}"))?
        .max(1) as usize;
    let buffer_frames = hwp
        .get_buffer_size()
        .map_err(|err| format!("failed to read ALSA buffer size: {err}"))?
        .max(period_frames as i64) as usize;
    let channels = hwp
        .get_channels()
        .map_err(|err| format!("failed to read ALSA channel count: {err}"))?
        .max(1) as usize;
    let can_pause = hwp.can_pause();

    let swp = pcm
        .sw_params_current()
        .map_err(|err| format!("failed to query ALSA sw params: {err}"))?;
    let _ = swp.set_avail_min(period_frames as i64);
    let start_threshold = swp.get_boundary().unwrap_or(buffer_frames as i64);
    let _ = swp.set_start_threshold(start_threshold);
    pcm.sw_params(&swp)
        .map_err(|err| format!("failed to apply ALSA sw params: {err}"))?;
    pcm.prepare()
        .map_err(|err| format!("failed to prepare ALSA output: {err}"))?;

    Ok(AlsaOutputFormat {
        sample_format,
        sample_rate: actual_rate,
        channels,
        period_frames,
        buffer_frames,
        can_pause,
    })
}

fn alsa_requested_buffer_time_us(buffer_secs: f64) -> u32 {
    if buffer_secs <= 0.0 || !buffer_secs.is_finite() {
        return ALSA_BUFFER_TIME_US;
    }
    (buffer_secs * 1_000_000.0)
        .round()
        .clamp(1_000.0, u32::MAX as f64) as u32
}

fn choose_sample_format(
    hwp: &HwParams<'_>,
    source_format: AudioSampleFormat,
) -> Result<AlsaSampleFormat, String> {
    for format in source_format.best_output_formats() {
        for (alsa_format, sample_format) in alsa_formats_for_audio_format(format) {
            if hwp.test_format(alsa_format).is_ok() && hwp.set_format(alsa_format).is_ok() {
                return Ok(sample_format);
            }
        }
    }
    Err("ALSA exclusive output does not accept f32/f64/s32/s24/s16/u8 PCM".to_string())
}

fn alsa_formats_for_audio_format(format: AudioSampleFormat) -> Vec<(Format, AlsaSampleFormat)> {
    match format {
        AudioSampleFormat::U8 => vec![(Format::U8, AlsaSampleFormat::U8)],
        AudioSampleFormat::S16 => vec![(Format::s16(), AlsaSampleFormat::I16)],
        AudioSampleFormat::S32 => vec![
            (Format::s32(), AlsaSampleFormat::I32),
            (Format::s24(), AlsaSampleFormat::I24In32),
            (Format::s24_3(), AlsaSampleFormat::I24),
        ],
        AudioSampleFormat::F32 => vec![(Format::float(), AlsaSampleFormat::F32)],
        AudioSampleFormat::F64 => vec![(Format::float64(), AlsaSampleFormat::F64)],
        AudioSampleFormat::Unknown => Vec::new(),
    }
}

fn pause_pcm(pcm: &PCM, format: &AlsaOutputFormat) {
    if format.can_pause && pcm.state() == State::Running && pcm.pause(true).is_ok() {
        return;
    }
    let _ = pcm.drop();
    let _ = pcm.prepare();
}

fn resume_pcm(pcm: &PCM) {
    if pcm.state() == State::Paused && pcm.pause(false).is_ok() {
        return;
    }
    let _ = pcm.prepare();
}

fn recover_pcm_state(pcm: &PCM) -> Result<(), String> {
    for _ in 0..=10 {
        match pcm.state() {
            State::Prepared | State::Running | State::Paused => return Ok(()),
            State::XRun | State::Draining => {
                if pcm.prepare().is_ok() {
                    return Ok(());
                }
            }
            State::Suspended => {
                if pcm.resume().is_ok() || pcm.prepare().is_ok() {
                    return Ok(());
                }
            }
            State::Disconnected | State::Open | State::Setup => break,
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "ALSA output could not recover from {:?}",
        pcm.state()
    ))
}

fn write_frames(
    pcm: &PCM,
    format: &AlsaOutputFormat,
    samples: &[f32],
    converted_i16: &mut Vec<i16>,
    converted_i32: &mut Vec<i32>,
    converted_i24: &mut Vec<u8>,
    converted_u8: &mut Vec<u8>,
    converted_f64: &mut Vec<f64>,
    stop: &OutputStopToken,
    shared: &SharedAudio,
) -> Result<(), String> {
    match format.sample_format {
        AlsaSampleFormat::F32 => write_typed_frames(pcm, format.channels, samples, stop, shared),
        AlsaSampleFormat::F64 => {
            converted_f64.resize(samples.len(), 0.0);
            for (target, sample) in converted_f64.iter_mut().zip(samples.iter().copied()) {
                *target = sample as f64;
            }
            write_typed_frames(pcm, format.channels, converted_f64, stop, shared)
        }
        AlsaSampleFormat::I16 => {
            converted_i16.resize(samples.len(), 0);
            for (target, sample) in converted_i16.iter_mut().zip(samples.iter().copied()) {
                *target = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            }
            write_typed_frames(pcm, format.channels, converted_i16, stop, shared)
        }
        AlsaSampleFormat::I32 => {
            converted_i32.resize(samples.len(), 0);
            for (target, sample) in converted_i32.iter_mut().zip(samples.iter().copied()) {
                *target = (sample.clamp(-1.0, 1.0) * i32::MAX as f32).round() as i32;
            }
            write_typed_frames(pcm, format.channels, converted_i32, stop, shared)
        }
        AlsaSampleFormat::I24In32 => {
            converted_i32.resize(samples.len(), 0);
            for (target, sample) in converted_i32.iter_mut().zip(samples.iter().copied()) {
                let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                *target = value << 8;
            }
            write_i24_in_32_frames(pcm, format.channels, converted_i32, stop, shared)
        }
        AlsaSampleFormat::I24 => {
            converted_i24.resize(samples.len() * 3, 0);
            for (target, sample) in converted_i24
                .chunks_exact_mut(3)
                .zip(samples.iter().copied())
            {
                write_i24_packed_sample(target, sample);
            }
            write_i24_packed_frames(pcm, converted_i24, stop, shared)
        }
        AlsaSampleFormat::U8 => {
            converted_u8.resize(samples.len(), 0);
            for (target, sample) in converted_u8.iter_mut().zip(samples.iter().copied()) {
                *target = ((sample.clamp(-1.0, 1.0) + 1.0) * 127.5).round() as u8;
            }
            write_typed_frames(pcm, format.channels, converted_u8, stop, shared)
        }
    }
}

fn write_i24_in_32_frames(
    pcm: &PCM,
    channels: usize,
    samples: &[i32],
    stop: &OutputStopToken,
    shared: &SharedAudio,
) -> Result<(), String> {
    let io = unsafe { pcm.io_unchecked::<i32>() };
    write_frames_with_io(pcm, &io, channels, samples, stop, shared)
}

fn write_i24_packed_frames(
    pcm: &PCM,
    samples: &[u8],
    stop: &OutputStopToken,
    shared: &SharedAudio,
) -> Result<(), String> {
    let io = pcm.io_bytes();
    let mut offset = 0usize;
    while offset < samples.len() {
        if stop.should_stop(shared) {
            return Ok(());
        }
        match io.writei(&samples[offset..]) {
            Ok(0) => return Err("ALSA output wrote zero frames".to_string()),
            Ok(frames) => {
                let bytes = pcm.frames_to_bytes(frames as i64).max(0) as usize;
                offset = offset.saturating_add(bytes);
            }
            Err(err) if err.errno() == libc::EAGAIN => {
                let _ = pcm.wait(Some(20));
            }
            Err(err) => recover_write_error(pcm, err)?,
        }
    }
    Ok(())
}

fn write_i24_packed_sample(target: &mut [u8], sample: f32) {
    let value = (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
    write_i24_ne_bytes(target, value);
}

#[cfg(target_endian = "little")]
fn write_i24_ne_bytes(target: &mut [u8], value: i32) {
    let bytes = value.to_le_bytes();
    target[0] = bytes[0];
    target[1] = bytes[1];
    target[2] = bytes[2];
}

#[cfg(target_endian = "big")]
fn write_i24_ne_bytes(target: &mut [u8], value: i32) {
    let bytes = value.to_be_bytes();
    target[0] = bytes[1];
    target[1] = bytes[2];
    target[2] = bytes[3];
}

fn write_typed_frames<T>(
    pcm: &PCM,
    channels: usize,
    samples: &[T],
    stop: &OutputStopToken,
    shared: &SharedAudio,
) -> Result<(), String>
where
    T: Copy + alsa::pcm::IoFormat,
{
    let io = pcm
        .io_checked::<T>()
        .map_err(|err| format!("failed to create ALSA output writer: {err}"))?;
    write_frames_with_io(pcm, &io, channels, samples, stop, shared)
}

fn write_frames_with_io<T>(
    pcm: &PCM,
    io: &alsa::pcm::IO<'_, T>,
    channels: usize,
    samples: &[T],
    stop: &OutputStopToken,
    shared: &SharedAudio,
) -> Result<(), String>
where
    T: Copy + alsa::pcm::IoFormat,
{
    let mut offset_frames = 0usize;
    let total_frames = samples.len() / channels.max(1);
    while offset_frames < total_frames {
        if stop.should_stop(shared) {
            return Ok(());
        }
        let offset = offset_frames * channels;
        match io.writei(&samples[offset..]) {
            Ok(0) => return Err("ALSA output wrote zero frames".to_string()),
            Ok(frames) => offset_frames = offset_frames.saturating_add(frames),
            Err(err) if err.errno() == libc::EAGAIN => {
                let _ = pcm.wait(Some(20));
            }
            Err(err) => recover_write_error(pcm, err)?,
        }
    }
    Ok(())
}

fn recover_write_error(pcm: &PCM, err: Error) -> Result<(), String> {
    pcm.try_recover(err, true)
        .map_err(|err| format!("failed to recover ALSA output: {err}"))
}
