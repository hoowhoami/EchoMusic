//! AudioSource implementation for Bluetooth audio.
//!
//! Provides a bridge between ALSA capture and the AirPlay audio pipeline.

use std::sync::Arc;
use std::time::Duration;

use airplay_audio::{AudioFrame, AudioSource};
use airplay_core::error::Result as CoreResult;
use airplay_core::{AudioCodec, AudioFormat, SampleRate};
use async_trait::async_trait;
use tracing::{debug, info};

use crate::alsa_capture::{calculate_rms, start_capture, CaptureConfig, CaptureHandle};
use crate::device::BluetoothDevice;
use crate::error::{BluetoothError, Result};

/// Timeout for receiving frames from capture thread.
const FRAME_TIMEOUT: Duration = Duration::from_millis(100);

/// Bluetooth audio source implementing the AudioSource trait.
///
/// This bridges ALSA capture from a bluez-alsa device to the AirPlay audio pipeline.
pub struct BluetoothAudioSource {
    /// Connected Bluetooth device info.
    device: BluetoothDevice,
    /// Capture handle (owns the capture thread).
    capture: Option<CaptureHandle>,
    /// Audio format.
    format: AudioFormat,
    /// Current timestamp in samples.
    timestamp: u64,
    /// Whether the stream has ended (device disconnected).
    eof: bool,
    /// Last calculated RMS level (for UI visualization).
    last_rms: f32,
    /// Total frames delivered.
    frames_delivered: u64,
}

impl BluetoothAudioSource {
    /// Create a new Bluetooth audio source for the given device.
    ///
    /// Does not start capture until `start()` is called.
    pub fn new(device: BluetoothDevice) -> Self {
        Self {
            device,
            capture: None,
            format: AudioFormat {
                codec: AudioCodec::Pcm, // Raw PCM from Bluetooth
                sample_rate: SampleRate::Hz44100,
                bit_depth: 16,
                channels: 2,
                frames_per_packet: 352, // Standard AirPlay frame size
            },
            timestamp: 0,
            eof: false,
            last_rms: 0.0,
            frames_delivered: 0,
        }
    }

    /// Start audio capture from the Bluetooth device.
    pub fn start(&mut self) -> Result<()> {
        if self.capture.is_some() {
            return Ok(()); // Already started
        }

        info!(
            "Starting Bluetooth audio capture from {}",
            self.device.display_name()
        );

        let config = CaptureConfig::for_bluealsa(&self.device.address.0);
        let handle = start_capture(config)?;

        self.capture = Some(handle);
        self.eof = false;
        self.timestamp = 0;
        self.frames_delivered = 0;

        Ok(())
    }

    /// Stop audio capture.
    pub fn stop(&mut self) {
        if let Some(mut capture) = self.capture.take() {
            info!("Stopping Bluetooth audio capture");
            capture.stop();
        }
        self.eof = true;
    }

    /// Check if capture is active.
    pub fn is_capturing(&self) -> bool {
        self.capture.as_ref().map(|c| c.is_running()).unwrap_or(false)
    }

    /// Get the connected device.
    pub fn device(&self) -> &BluetoothDevice {
        &self.device
    }

    /// Get the last calculated RMS level (0.0 to 1.0).
    pub fn rms_level(&self) -> f32 {
        self.last_rms
    }

    /// Get total samples captured.
    pub fn total_samples(&self) -> u64 {
        self.capture
            .as_ref()
            .map(|c| c.total_samples())
            .unwrap_or(0)
    }

    /// Get total frames delivered.
    pub fn frames_delivered(&self) -> u64 {
        self.frames_delivered
    }
}

#[async_trait]
impl AudioSource for BluetoothAudioSource {
    /// Get the audio format.
    fn format(&self) -> AudioFormat {
        self.format.clone()
    }

    /// Duration is unknown for live streams.
    fn duration_samples(&self) -> Option<u64> {
        None // Live stream has no fixed duration
    }

    /// Read the next frame of audio.
    async fn read_frame(&mut self) -> CoreResult<Option<AudioFrame>> {
        let capture = match &mut self.capture {
            Some(c) => c,
            None => {
                // Not started or already stopped
                return Ok(None);
            }
        };

        // Check if capture is still running
        if !capture.is_running() {
            self.eof = true;
            return Ok(None);
        }

        // Try to receive a frame with timeout
        // We use spawn_blocking to avoid blocking the async runtime
        let frame_result = tokio::task::spawn_blocking({
            let timeout = FRAME_TIMEOUT;
            // We need to be careful here - CaptureHandle is not Send
            // So we use a channel-based approach instead
            move || {
                // This closure captures nothing from capture
                // The actual recv happens in the main code path
                timeout
            }
        })
        .await;

        // Actually try to receive (non-blocking multiple times with small waits)
        let mut attempts = 0;
        let max_attempts = 10;
        loop {
            match capture.try_recv() {
                Some(captured) => {
                    // Calculate RMS for visualization
                    self.last_rms = calculate_rms(&captured.samples);

                    // Convert to AudioFrame
                    let frame = AudioFrame::new(captured.samples, self.timestamp);

                    self.timestamp += frame.samples.len() as u64 / 2; // Stereo
                    self.frames_delivered += 1;

                    return Ok(Some(frame));
                }
                None => {
                    attempts += 1;
                    if attempts >= max_attempts {
                        // No data available within timeout period
                        // This is normal for live streams - just return None temporarily
                        debug!("No audio data available (buffer empty)");
                        return Ok(None);
                    }
                    // Small sleep to avoid busy waiting
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        }
    }

    /// Seeking is not supported for live Bluetooth streams.
    async fn seek(&mut self, _position: u64) -> CoreResult<()> {
        Err(airplay_core::error::Error::Streaming(
            airplay_core::error::StreamingError::InvalidFormat(
                "Cannot seek in live Bluetooth stream".to_string(),
            ),
        ))
    }

    /// Check if stream has ended (device disconnected).
    fn is_eof(&self) -> bool {
        self.eof
    }
}

impl Drop for BluetoothAudioSource {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::Address;

    fn test_device() -> BluetoothDevice {
        BluetoothDevice {
            address: Address::new("00:11:22:33:44:55"),
            name: "Test Device".to_string(),
            alias: None,
            paired: true,
            connected: true,
            trusted: true,
            uuids: Default::default(),
            rssi: Some(-50),
            icon: None,
        }
    }

    #[test]
    fn new_source_has_correct_format() {
        let device = test_device();
        let source = BluetoothAudioSource::new(device);

        let format = source.format();
        assert_eq!(format.codec, AudioCodec::Pcm);
        assert_eq!(format.sample_rate, SampleRate::Hz44100);
        assert_eq!(format.bit_depth, 16);
        assert_eq!(format.channels, 2);
    }

    #[test]
    fn duration_is_none_for_live_stream() {
        let device = test_device();
        let source = BluetoothAudioSource::new(device);
        assert!(source.duration_samples().is_none());
    }

    #[test]
    fn not_capturing_before_start() {
        let device = test_device();
        let source = BluetoothAudioSource::new(device);
        assert!(!source.is_capturing());
    }

    #[test]
    fn eof_false_initially() {
        let device = test_device();
        let source = BluetoothAudioSource::new(device);
        assert!(!source.is_eof());
    }
}
