//! Post-DSP tap. The realtime callback only tries to enqueue i16 stereo.
//! A feeder thread writes the local socket and may block; the callback never does.
//! Byte layout matches native/echo-airplay/src/pcm.rs.

use std::io::Write;
use napi_derive::napi;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const QUEUE_FRAMES: usize = 64;

struct Tap {
    enabled: AtomicBool,
    epoch: AtomicU64,
    overruns: AtomicU64,
    queued_frames: AtomicU64,
    queued_bytes: AtomicU64,
    written_frames: AtomicU64,
    written_bytes: AtomicU64,
    write_errors: AtomicU64,
    sender: Mutex<Option<SyncSender<Vec<u8>>>>,
    feeder: Mutex<Option<JoinHandle<()>>>,
}

#[napi(object)]
pub struct AirplayTapStats {
    pub enabled: bool,
    pub epoch: u32,
    pub queued_frames: u32,
    pub queued_bytes: u32,
    pub written_frames: u32,
    pub written_bytes: u32,
    pub overruns: u32,
    pub write_errors: u32,
}

fn tap() -> &'static Tap {
    static TAP: OnceLock<Tap> = OnceLock::new();
    TAP.get_or_init(|| Tap {
        enabled: AtomicBool::new(false),
        epoch: AtomicU64::new(0),
        overruns: AtomicU64::new(0),
        queued_frames: AtomicU64::new(0),
        queued_bytes: AtomicU64::new(0),
        written_frames: AtomicU64::new(0),
        written_bytes: AtomicU64::new(0),
        write_errors: AtomicU64::new(0),
        sender: Mutex::new(None),
        feeder: Mutex::new(None),
    })
}

pub(crate) fn is_enabled() -> bool {
    tap().enabled.load(Ordering::Acquire)
}

pub(crate) fn push_f32(samples: &[f32], channels: usize, sample_rate: u32) {
    let state = tap();
    if !state.enabled.load(Ordering::Acquire) || samples.is_empty() || sample_rate == 0 {
        return;
    }
    let Ok(guard) = state.sender.try_lock() else {
        state.overruns.fetch_add(1, Ordering::Relaxed);
        return;
    };
    let Some(sender) = guard.as_ref() else {
        return;
    };
    let stereo = to_stereo_i16(samples, channels);
    if stereo.is_empty() {
        return;
    }
    let bytes = encode(state.epoch.load(Ordering::Acquire), sample_rate, &stereo);
    let len = bytes.len() as u64;
    match sender.try_send(bytes) {
        Ok(()) => {
            state.queued_frames.fetch_add(1, Ordering::Relaxed);
            state.queued_bytes.fetch_add(len, Ordering::Relaxed);
        }
        Err(TrySendError::Full(_)) => {
            state.overruns.fetch_add(1, Ordering::Relaxed);
        }
        Err(TrySendError::Disconnected(_)) => {
            state.write_errors.fetch_add(1, Ordering::Relaxed);
        }
    }
}

fn to_stereo_i16(input: &[f32], channels: usize) -> Vec<i16> {
    let channels = channels.max(1);
    let frames = input.len() / channels;
    let mut out = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        let base = frame * channels;
        let left = f32_to_i16(input.get(base).copied().unwrap_or(0.0));
        let right = if channels == 1 {
            left
        } else {
            f32_to_i16(input.get(base + 1).copied().unwrap_or(0.0))
        };
        out.push(left);
        out.push(right);
    }
    out
}

fn f32_to_i16(sample: f32) -> i16 {
    if !sample.is_finite() {
        return 0;
    }
    (sample.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

fn encode(epoch: u64, sample_rate: u32, samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(18 + samples.len() * 2);
    bytes.extend_from_slice(&epoch.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    bytes
}

fn stop_feeder() {
    let state = tap();
    state.enabled.store(false, Ordering::Release);
    {
        let mut sender = state.sender.lock().unwrap_or_else(|err| err.into_inner());
        sender.take();
    }
    if let Some(handle) = state.feeder.lock().unwrap_or_else(|err| err.into_inner()).take() {
        let _ = handle.join();
    }
}

#[napi]
pub fn set_airplay_tap(port: u32, enabled: bool) -> napi::Result<()> {
    stop_feeder();
    if !enabled || port == 0 {
        return Ok(());
    }
    let stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(|err| {
            napi::Error::from_reason(format!("AirPlay 音频端口无效: {err}"))
        })?,
        Duration::from_secs(2),
    )
    .map_err(|err| napi::Error::from_reason(format!("连接 AirPlay 音频出口失败: {err}")))?;
    stream.set_nodelay(true).ok();
    let (sender, receiver) = sync_channel(QUEUE_FRAMES);
    *tap().sender.lock().unwrap_or_else(|err| err.into_inner()) = Some(sender);
    tap().epoch.store(1, Ordering::Release);
    tap().overruns.store(0, Ordering::Release);
    tap().queued_frames.store(0, Ordering::Release);
    tap().queued_bytes.store(0, Ordering::Release);
    tap().written_frames.store(0, Ordering::Release);
    tap().written_bytes.store(0, Ordering::Release);
    tap().write_errors.store(0, Ordering::Release);
    tap().enabled.store(true, Ordering::Release);
    let handle = thread::Builder::new()
        .name("airplay-tap".to_string())
        .spawn(move || write_loop(stream, receiver))
        .map_err(|err| napi::Error::from_reason(format!("启动 AirPlay 音频出口失败: {err}")))?;
    *tap().feeder.lock().unwrap_or_else(|err| err.into_inner()) = Some(handle);
    Ok(())
}

#[napi]
pub fn set_airplay_epoch(epoch: u32) {
    tap().epoch.store(u64::from(epoch), Ordering::Release);
}

#[napi]
pub fn get_airplay_tap_stats() -> AirplayTapStats {
    let state = tap();
    AirplayTapStats {
        enabled: state.enabled.load(Ordering::Acquire),
        epoch: state.epoch.load(Ordering::Acquire).min(u64::from(u32::MAX)) as u32,
        queued_frames: state
            .queued_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        queued_bytes: state
            .queued_bytes
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        written_frames: state
            .written_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        written_bytes: state
            .written_bytes
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        overruns: state
            .overruns
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        write_errors: state
            .write_errors
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
    }
}

fn write_loop(mut stream: TcpStream, receiver: Receiver<Vec<u8>>) {
    while let Ok(frame) = receiver.recv() {
        let len = frame.len() as u64;
        if stream.write_all(&frame).is_err() {
            tap().write_errors.fetch_add(1, Ordering::Relaxed);
            break;
        }
        tap().written_frames.fetch_add(1, Ordering::Relaxed);
        tap().written_bytes.fetch_add(len, Ordering::Relaxed);
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::encode;

    #[test]
    fn tap_bytes_match_the_airplay_decoder() {
        assert_eq!(
            encode(1, 44_100, &[1, -1]),
            vec![1, 0, 0, 0, 0, 0, 0, 0, 0x44, 0xAC, 0, 0, 2, 0, 2, 0, 0, 0, 1, 0, 0xFF, 0xFF]
        );
    }
}
