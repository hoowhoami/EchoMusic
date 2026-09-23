//! ALSA PCM capture for Bluetooth audio.
//!
//! Captures audio from bluez-alsa virtual PCM devices using a dedicated thread.
//! Supports both standard (44.1kHz/S16) and HD (48kHz/S24) formats with resampling.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

use alsa::pcm::{Access, Format, HwParams, PCM};
use alsa::{Direction, ValueOr};
use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use tracing::{debug, error, info, warn};

use crate::error::{BluetoothError, Result};

/// Default sample rate for Bluetooth audio (CD quality).
pub const DEFAULT_SAMPLE_RATE: u32 = 44100;

/// Sample rate for HD Bluetooth audio (aptX HD, LDAC).
pub const SAMPLE_RATE_HD: u32 = 48000;

/// Default number of channels (stereo).
pub const DEFAULT_CHANNELS: u32 = 2;

/// Default bit depth.
pub const DEFAULT_BIT_DEPTH: u32 = 16;

/// HD bit depth.
pub const BIT_DEPTH_HD: u32 = 24;

/// Number of frames per ALSA read period.
pub const FRAMES_PER_PERIOD: u32 = 1024;

/// ALSA buffer size in frames (multiple of period).
pub const BUFFER_FRAMES: u32 = 4096;

/// Channel capacity for audio frames (limits memory usage).
const CHANNEL_CAPACITY: usize = 8;

/// Audio format for capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    /// Standard 16-bit signed integer, little-endian.
    S16LE,
    /// HD 24-bit signed integer in 32-bit container, little-endian.
    S24LE,
}

impl Default for AudioFormat {
    fn default() -> Self {
        Self::S16LE
    }
}

/// Audio frame captured from ALSA.
#[derive(Debug, Clone)]
pub struct CapturedFrame {
    /// Interleaved PCM samples (i16, stereo).
    /// Note: Even for HD capture, samples are converted to i16 for AirPlay compatibility.
    pub samples: Vec<i16>,
    /// Timestamp in samples from capture start (at output sample rate, 44100 Hz).
    pub timestamp: u64,
}

/// Handle to control a running capture thread.
pub struct CaptureHandle {
    /// Receiver for captured frames.
    receiver: Receiver<CapturedFrame>,
    /// Flag to signal thread to stop.
    stop_flag: Arc<AtomicBool>,
    /// Thread handle.
    thread_handle: Option<JoinHandle<()>>,
    /// Total samples captured.
    total_samples: u64,
}

impl CaptureHandle {
    /// Try to receive the next captured frame (non-blocking).
    pub fn try_recv(&mut self) -> Option<CapturedFrame> {
        match self.receiver.try_recv() {
            Ok(frame) => {
                self.total_samples += (frame.samples.len() / 2) as u64;
                Some(frame)
            }
            Err(_) => None,
        }
    }

    /// Receive the next captured frame (blocking).
    pub fn recv(&mut self) -> Result<CapturedFrame> {
        match self.receiver.recv() {
            Ok(frame) => {
                self.total_samples += (frame.samples.len() / 2) as u64;
                Ok(frame)
            }
            Err(_) => Err(BluetoothError::CaptureStopped),
        }
    }

    /// Receive with timeout.
    pub fn recv_timeout(&mut self, timeout: std::time::Duration) -> Result<CapturedFrame> {
        match self.receiver.recv_timeout(timeout) {
            Ok(frame) => {
                self.total_samples += (frame.samples.len() / 2) as u64;
                Ok(frame)
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => Err(BluetoothError::Timeout),
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                Err(BluetoothError::CaptureStopped)
            }
        }
    }

    /// Check if capture is still running.
    pub fn is_running(&self) -> bool {
        !self.stop_flag.load(Ordering::Relaxed)
    }

    /// Get total samples captured.
    pub fn total_samples(&self) -> u64 {
        self.total_samples
    }

    /// Stop capture and wait for thread to finish.
    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// ALSA capture configuration.
#[derive(Debug, Clone)]
pub struct CaptureConfig {
    /// ALSA device name (e.g., "bluealsa:DEV=XX:XX:XX:XX:XX:XX,PROFILE=a2dp").
    pub device: String,
    /// Sample rate in Hz (input rate, may differ from output).
    pub sample_rate: u32,
    /// Number of channels.
    pub channels: u32,
    /// Audio format.
    pub format: AudioFormat,
    /// Whether resampling is needed (48kHz -> 44.1kHz).
    pub needs_resampling: bool,
}

impl CaptureConfig {
    /// Create config for a bluez-alsa device (standard quality).
    pub fn for_bluealsa(mac_address: &str) -> Self {
        Self {
            device: format!("bluealsa:DEV={},PROFILE=a2dp", mac_address.to_uppercase()),
            sample_rate: DEFAULT_SAMPLE_RATE,
            channels: DEFAULT_CHANNELS,
            format: AudioFormat::S16LE,
            needs_resampling: false,
        }
    }

    /// Create config for a bluez-alsa device (HD quality - aptX HD, LDAC).
    ///
    /// Captures at 48kHz/S24 and resamples to 44.1kHz for AirPlay compatibility.
    pub fn for_bluealsa_hd(mac_address: &str) -> Self {
        Self {
            device: format!("bluealsa:DEV={},PROFILE=a2dp", mac_address.to_uppercase()),
            sample_rate: SAMPLE_RATE_HD,
            channels: DEFAULT_CHANNELS,
            format: AudioFormat::S24LE,
            needs_resampling: true,
        }
    }
}

/// Start audio capture from an ALSA device.
///
/// Returns a handle to control the capture and receive frames.
pub fn start_capture(config: CaptureConfig) -> Result<CaptureHandle> {
    info!("Starting ALSA capture from device: {}", config.device);
    info!(
        "Capture config: {}Hz, {} channels, {:?}, resample={}",
        config.sample_rate, config.channels, config.format, config.needs_resampling
    );

    let (tx, rx) = bounded::<CapturedFrame>(CHANNEL_CAPACITY);
    let stop_flag = Arc::new(AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();

    let handle = thread::Builder::new()
        .name("alsa-capture".to_string())
        .spawn(move || {
            if let Err(e) = capture_thread(&config, tx, stop_flag_clone) {
                error!("Capture thread error: {}", e);
            }
            info!("Capture thread stopped");
        })
        .map_err(|e| BluetoothError::Alsa(format!("Failed to spawn capture thread: {}", e)))?;

    Ok(CaptureHandle {
        receiver: rx,
        stop_flag,
        thread_handle: Some(handle),
        total_samples: 0,
    })
}

/// The capture thread function.
fn capture_thread(
    config: &CaptureConfig,
    tx: Sender<CapturedFrame>,
    stop_flag: Arc<AtomicBool>,
) -> Result<()> {
    // Open PCM device for capture
    let pcm = PCM::new(&config.device, Direction::Capture, false).map_err(|e| {
        BluetoothError::Alsa(format!("Failed to open ALSA device '{}': {}", config.device, e))
    })?;

    // Configure hardware parameters
    {
        let hwp = HwParams::any(&pcm).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to get hardware params: {}", e))
        })?;

        hwp.set_channels(config.channels).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to set channels: {}", e))
        })?;

        hwp.set_rate(config.sample_rate, ValueOr::Nearest).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to set sample rate: {}", e))
        })?;

        // Set format based on config
        let alsa_format = match config.format {
            AudioFormat::S16LE => Format::s16(),
            AudioFormat::S24LE => Format::S243LE, // 24-bit in 3-byte container
        };
        hwp.set_format(alsa_format).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to set format: {}", e))
        })?;

        hwp.set_access(Access::RWInterleaved).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to set access: {}", e))
        })?;

        hwp.set_buffer_size(BUFFER_FRAMES as alsa::pcm::Frames).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to set buffer size: {}", e))
        })?;

        hwp.set_period_size(FRAMES_PER_PERIOD as alsa::pcm::Frames, ValueOr::Nearest)
            .map_err(|e| BluetoothError::Alsa(format!("Failed to set period size: {}", e)))?;

        pcm.hw_params(&hwp).map_err(|e| {
            BluetoothError::Alsa(format!("Failed to apply hardware params: {}", e))
        })?;
    }

    // Prepare PCM for use
    pcm.prepare().map_err(|e| {
        BluetoothError::Alsa(format!("Failed to prepare PCM: {}", e))
    })?;

    info!(
        "ALSA capture configured: {}Hz, {} channels, {:?}, {} frames/period",
        config.sample_rate, config.channels, config.format, FRAMES_PER_PERIOD
    );

    // Choose capture path based on format
    match config.format {
        AudioFormat::S16LE => capture_s16(pcm, config, tx, stop_flag),
        AudioFormat::S24LE => capture_s24_with_resample(pcm, config, tx, stop_flag),
    }
}

/// Capture loop for S16 format (no conversion needed).
fn capture_s16(
    pcm: PCM,
    config: &CaptureConfig,
    tx: Sender<CapturedFrame>,
    stop_flag: Arc<AtomicBool>,
) -> Result<()> {
    let samples_per_period = (FRAMES_PER_PERIOD * config.channels) as usize;
    let mut buffer = vec![0i16; samples_per_period];
    let mut timestamp: u64 = 0;

    let io = pcm.io_i16().map_err(|e| {
        BluetoothError::Alsa(format!("Failed to get I/O interface: {}", e))
    })?;

    while !stop_flag.load(Ordering::Relaxed) {
        let frames_read = match io.readi(&mut buffer) {
            Ok(n) => n,
            Err(e) => {
                if !handle_alsa_error(&pcm, &e)? {
                    break;
                }
                continue;
            }
        };

        if frames_read == 0 {
            continue;
        }

        let samples_count = (frames_read as u32 * config.channels) as usize;
        let frame = CapturedFrame {
            samples: buffer[..samples_count].to_vec(),
            timestamp,
        };

        timestamp += frames_read as u64;

        if !send_frame(&tx, frame) {
            break;
        }
    }

    Ok(())
}

/// Capture loop for S24 format with conversion to S16 and resampling to 44.1kHz.
fn capture_s24_with_resample(
    pcm: PCM,
    config: &CaptureConfig,
    tx: Sender<CapturedFrame>,
    stop_flag: Arc<AtomicBool>,
) -> Result<()> {
    let channels = config.channels as usize;

    // Create high-quality sinc resampler: 48kHz -> 44.1kHz
    // Uses the shared airplay-resampler crate with mastering-quality settings (sinc_len: 512)
    let mut resampler = airplay_resampler::Resampler::with_chunk_size(
        SAMPLE_RATE_HD,
        DEFAULT_SAMPLE_RATE,
        config.channels as u8,
        FRAMES_PER_PERIOD as usize,
    ).map_err(|e| BluetoothError::Alsa(format!("Failed to create resampler: {}", e)))?;

    // Pre-allocate buffers
    // S24_3LE: 3 bytes per sample
    let bytes_per_period = (FRAMES_PER_PERIOD * config.channels) as usize * 3;
    let mut raw_buffer = vec![0u8; bytes_per_period];

    // Deinterleaved f32 buffers for resampler (one Vec per channel)
    let mut input_channels: Vec<Vec<f32>> = (0..channels)
        .map(|_| Vec::with_capacity(FRAMES_PER_PERIOD as usize))
        .collect();

    let mut timestamp: u64 = 0;

    // Discard first N frames from ALSA to allow Bluetooth transport to stabilize
    // This prevents the "warm-up" distortion at stream start
    const WARMUP_FRAMES_TO_DISCARD: usize = 10; // ~230ms at 1024 frames/period, 44.1kHz
    let mut warmup_frames_remaining = WARMUP_FRAMES_TO_DISCARD;

    // Get raw I/O for reading bytes
    let io = pcm.io_bytes();

    while !stop_flag.load(Ordering::Relaxed) {
        // Read raw bytes (S24_3LE format)
        let bytes_to_read = (FRAMES_PER_PERIOD as usize) * channels * 3;
        match io.readi(&mut raw_buffer[..bytes_to_read]) {
            Ok(frames_read) => {
                if frames_read == 0 {
                    continue;
                }

                // Discard initial frames to allow Bluetooth/ALSA to stabilize
                if warmup_frames_remaining > 0 {
                    warmup_frames_remaining -= 1;
                    if warmup_frames_remaining == 0 {
                        info!("Warmup complete - discarded {} initial ALSA frames, now streaming",
                            WARMUP_FRAMES_TO_DISCARD);
                    } else {
                        debug!("Warmup: discarding frame ({} remaining)", warmup_frames_remaining);
                    }
                    continue;
                }

                // Convert S24_3LE to f32 and deinterleave
                for ch in &mut input_channels {
                    ch.clear();
                }

                for frame_idx in 0..frames_read {
                    for ch in 0..channels {
                        let byte_idx = (frame_idx * channels + ch) * 3;
                        // S24_3LE: little-endian 24-bit in 3 bytes
                        let sample_bytes = [
                            raw_buffer[byte_idx],
                            raw_buffer[byte_idx + 1],
                            raw_buffer[byte_idx + 2],
                        ];
                        // Sign-extend 24-bit to 32-bit
                        let sample_i32 = ((sample_bytes[2] as i32) << 24)
                            | ((sample_bytes[1] as i32) << 16)
                            | ((sample_bytes[0] as i32) << 8);
                        let sample_i32 = sample_i32 >> 8; // Arithmetic shift to sign-extend

                        // Normalize to -1.0..1.0 (24-bit range is -8388608 to 8388607)
                        let sample_f32 = sample_i32 as f32 / 8388608.0;
                        input_channels[ch].push(sample_f32);
                    }
                }

                // Ensure we have enough samples for the resampler
                if input_channels[0].len() < resampler.input_frames_next() {
                    continue;
                }

                // Resample using high-quality sinc interpolation
                let resampled = match resampler.process_f32(&input_channels) {
                    Ok(output) => output,
                    Err(e) => {
                        warn!("Resampling error: {}", e);
                        continue;
                    }
                };

                if resampled.is_empty() || resampled[0].is_empty() {
                    continue;
                }

                let output_frames = resampled[0].len();

                // Convert f32 back to i16 with TPDF dithering and interleave
                let samples = airplay_resampler::interleave_with_dither(&resampled);

                let frame = CapturedFrame {
                    samples,
                    timestamp,
                };

                timestamp += output_frames as u64;

                if !send_frame(&tx, frame) {
                    break;
                }
            }
            Err(e) => {
                let errno = e.errno();
                if errno == libc::EPIPE {
                    warn!("ALSA buffer underrun, recovering...");
                    if let Err(recover_err) = pcm.recover(errno, true) {
                        error!("Failed to recover from underrun: {}", recover_err);
                        break;
                    }
                    continue;
                } else if errno == libc::ESTRPIPE {
                    warn!("ALSA device suspended, recovering...");
                    if let Err(recover_err) = pcm.recover(errno, true) {
                        error!("Failed to recover from suspend: {}", recover_err);
                        break;
                    }
                    continue;
                } else {
                    error!("ALSA read error: {}", e);
                    break;
                }
            }
        }
    }

    Ok(())
}

/// Handle common ALSA errors, returns Ok(true) to continue, Ok(false) to break.
fn handle_alsa_error(pcm: &PCM, e: &alsa::Error) -> Result<bool> {
    let errno = e.errno();
    if errno == libc::EPIPE {
        warn!("ALSA buffer underrun, recovering...");
        if let Err(recover_err) = pcm.recover(errno, true) {
            error!("Failed to recover from underrun: {}", recover_err);
            return Ok(false);
        }
        Ok(true)
    } else if errno == libc::ESTRPIPE {
        warn!("ALSA device suspended, recovering...");
        if let Err(recover_err) = pcm.recover(errno, true) {
            error!("Failed to recover from suspend: {}", recover_err);
            return Ok(false);
        }
        Ok(true)
    } else {
        error!("ALSA read error: {}", e);
        Ok(false)
    }
}

/// Send frame to channel, returns false if channel disconnected.
fn send_frame(tx: &Sender<CapturedFrame>, frame: CapturedFrame) -> bool {
    match tx.try_send(frame) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            debug!("Capture channel full, dropping frame");
            true
        }
        Err(TrySendError::Disconnected(_)) => {
            debug!("Capture channel disconnected");
            false
        }
    }
}

/// Calculate RMS level from audio samples.
pub fn calculate_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum_of_squares: f64 = samples
        .iter()
        .map(|&s| (s as f64) * (s as f64))
        .sum();

    let rms = (sum_of_squares / samples.len() as f64).sqrt();

    // Normalize to 0.0-1.0 range (i16 max is 32767)
    (rms / 32767.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    mod capture_config {
        use super::*;

        #[test]
        fn for_bluealsa_formats_device_string() {
            let config = CaptureConfig::for_bluealsa("aa:bb:cc:dd:ee:ff");
            assert_eq!(
                config.device,
                "bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"
            );
            assert_eq!(config.sample_rate, 44100);
            assert_eq!(config.channels, 2);
            assert_eq!(config.format, AudioFormat::S16LE);
            assert!(!config.needs_resampling);
        }

        #[test]
        fn for_bluealsa_hd_formats_device_string() {
            let config = CaptureConfig::for_bluealsa_hd("aa:bb:cc:dd:ee:ff");
            assert_eq!(
                config.device,
                "bluealsa:DEV=AA:BB:CC:DD:EE:FF,PROFILE=a2dp"
            );
            assert_eq!(config.sample_rate, 48000);
            assert_eq!(config.channels, 2);
            assert_eq!(config.format, AudioFormat::S24LE);
            assert!(config.needs_resampling);
        }
    }

    mod rms_calculation {
        use super::*;

        #[test]
        fn silent_signal_has_zero_rms() {
            let samples = vec![0i16; 100];
            assert_eq!(calculate_rms(&samples), 0.0);
        }

        #[test]
        fn max_signal_has_high_rms() {
            let samples = vec![i16::MAX; 100];
            let rms = calculate_rms(&samples);
            assert!(rms > 0.9, "RMS should be close to 1.0, got {}", rms);
        }

        #[test]
        fn sine_wave_has_expected_rms() {
            // A full-scale sine wave has RMS of ~0.707 of peak
            let samples: Vec<i16> = (0..1000)
                .map(|i| {
                    let t = i as f64 / 1000.0 * std::f64::consts::TAU;
                    (t.sin() * 32767.0) as i16
                })
                .collect();
            let rms = calculate_rms(&samples);
            // Should be approximately 0.707
            assert!(rms > 0.65 && rms < 0.75, "RMS should be ~0.707, got {}", rms);
        }

        #[test]
        fn empty_samples_returns_zero() {
            assert_eq!(calculate_rms(&[]), 0.0);
        }
    }
}
