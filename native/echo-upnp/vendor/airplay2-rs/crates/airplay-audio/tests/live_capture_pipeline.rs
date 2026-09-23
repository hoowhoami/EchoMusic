//! Integration test for live audio capture -> encode pipeline.
//!
//! This test validates the full pipeline from simulated PipeWire capture
//! through the LiveAudioDecoder to ALAC encoding, without needing actual
//! Bluetooth or AirPlay devices.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use airplay_audio::{
    LiveAudioDecoder, LiveFrameSender, LivePcmFrame,
    AudioBuffer, AudioFrame,
    create_encoder, AudioEncoder,
};
use airplay_core::{AudioFormat, AudioCodec, SampleRate};

/// Generate a stereo sine wave for testing.
fn generate_sine_wave(frequency: f64, sample_rate: u32, num_frames: usize) -> Vec<i16> {
    let mut samples = Vec::with_capacity(num_frames * 2);
    for i in 0..num_frames {
        let t = i as f64 / sample_rate as f64;
        let value = (2.0 * std::f64::consts::PI * frequency * t).sin();
        let sample = (value * 16000.0) as i16; // ~50% amplitude
        samples.push(sample); // Left
        samples.push(sample); // Right
    }
    samples
}

/// Calculate RMS of audio samples.
fn calculate_rms(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64).powi(2)).sum();
    (sum / samples.len() as f64).sqrt()
}

fn test_format() -> AudioFormat {
    AudioFormat {
        codec: AudioCodec::Alac,
        sample_rate: SampleRate::Hz44100,
        bit_depth: 16,
        channels: 2,
        frames_per_packet: 352,
    }
}

/// Simulates PipeWire capture behavior - sends frames at realistic intervals.
fn simulate_pipewire_capture(
    sender: LiveFrameSender,
    stop: Arc<AtomicBool>,
    frames_sent: Arc<AtomicU64>,
    duration_secs: f64,
) {
    let sample_rate = 44100u32;
    let period_frames = 1024usize; // PipeWire default period size
    let period_duration = Duration::from_secs_f64(period_frames as f64 / sample_rate as f64);

    let start = Instant::now();
    let mut phase = 0usize;

    println!("PipeWire simulator: period={}frames, interval={:?}", period_frames, period_duration);

    while !stop.load(Ordering::Relaxed) && start.elapsed().as_secs_f64() < duration_secs {
        // Generate audio for this period (440Hz sine wave)
        let samples = generate_sine_wave(440.0, sample_rate, period_frames);

        let frame = LivePcmFrame {
            samples,
            channels: 2,
            sample_rate,
        };

        if sender.try_send(frame) {
            frames_sent.fetch_add(1, Ordering::Relaxed);
            phase += period_frames;
        } else {
            println!("PipeWire simulator: channel full at frame {}", phase);
        }

        // Sleep for period duration (simulating real-time capture)
        thread::sleep(period_duration);
    }

    let total = frames_sent.load(Ordering::Relaxed);
    println!("PipeWire simulator: sent {} periods ({} samples)", total, total * period_frames as u64);
}

#[test]
fn test_live_decoder_basic_flow() {
    println!("\n=== Test: Basic LiveAudioDecoder Flow ===");

    let (sender, mut decoder) = LiveAudioDecoder::create_pair(44100, 2, 16);
    decoder.set_recv_timeout(Duration::from_millis(100));

    let format = test_format();
    let frames_per_packet = format.frames_per_packet as usize;

    // Send enough data for several packets
    for i in 0..10 {
        let samples = generate_sine_wave(440.0, 44100, 1024);
        let frame = LivePcmFrame {
            samples,
            channels: 2,
            sample_rate: 44100,
        };
        assert!(sender.try_send(frame), "Failed to send frame {}", i);
    }

    // Decode packets
    let mut decoded_count = 0;
    loop {
        match decoder.decode_resampled(&format, frames_per_packet) {
            Ok(Some(frame)) => {
                assert_eq!(frame.samples.len(), frames_per_packet * 2, "Wrong sample count");
                let rms = calculate_rms(&frame.samples);
                assert!(rms > 1000.0, "Audio too quiet: RMS={}", rms);
                decoded_count += 1;
            }
            Ok(None) => break,
            Err(e) => panic!("Decode error: {}", e),
        }
    }

    println!("Decoded {} packets", decoded_count);
    assert!(decoded_count >= 25, "Expected at least 25 packets, got {}", decoded_count);
}

#[test]
fn test_live_decoder_to_encoder() {
    println!("\n=== Test: LiveAudioDecoder -> ALAC Encoder ===");

    let (sender, mut decoder) = LiveAudioDecoder::create_pair(44100, 2, 16);
    decoder.set_recv_timeout(Duration::from_millis(100));

    let format = test_format();
    let frames_per_packet = format.frames_per_packet as usize;

    // Create ALAC encoder
    let mut encoder = create_encoder(format.clone()).expect("Failed to create encoder");

    // Send test audio
    for _ in 0..20 {
        let samples = generate_sine_wave(440.0, 44100, 1024);
        let frame = LivePcmFrame {
            samples,
            channels: 2,
            sample_rate: 44100,
        };
        sender.try_send(frame);
    }

    // Decode and encode
    let mut encoded_packets = Vec::new();
    loop {
        match decoder.decode_resampled(&format, frames_per_packet) {
            Ok(Some(frame)) => {
                let packet = encoder.encode(&frame.samples).expect("Encode failed");

                // Verify packet
                assert!(!packet.data.is_empty(), "Empty encoded packet");
                assert_eq!(packet.samples, frames_per_packet as u32);

                // ALAC should compress - raw is 1408 bytes (352*2*2)
                assert!(packet.data.len() < 1408, "No compression: {} bytes", packet.data.len());

                encoded_packets.push(packet);
            }
            Ok(None) => break,
            Err(e) => panic!("Decode error: {}", e),
        }
    }

    println!("Encoded {} packets", encoded_packets.len());

    // Analyze compression
    let total_raw = encoded_packets.len() * 1408;
    let total_encoded: usize = encoded_packets.iter().map(|p| p.data.len()).sum();
    let ratio = total_encoded as f64 / total_raw as f64;
    println!("Compression: {} raw -> {} encoded ({:.1}%)", total_raw, total_encoded, ratio * 100.0);

    assert!(encoded_packets.len() >= 45, "Expected at least 45 packets");
}

#[test]
fn test_simulated_realtime_capture() {
    println!("\n=== Test: Simulated Real-time PipeWire Capture ===");

    let (sender, mut decoder) = LiveAudioDecoder::create_pair(44100, 2, 8);
    decoder.set_recv_timeout(Duration::from_millis(50));

    let format = test_format();
    let frames_per_packet = format.frames_per_packet as usize;

    let stop = Arc::new(AtomicBool::new(false));
    let frames_sent = Arc::new(AtomicU64::new(0));

    // Spawn capture simulator
    let stop_clone = Arc::clone(&stop);
    let frames_sent_clone = Arc::clone(&frames_sent);
    let capture_thread = thread::spawn(move || {
        simulate_pipewire_capture(sender, stop_clone, frames_sent_clone, 2.0);
    });

    // Consumer loop (simulates streamer)
    let mut encoder = create_encoder(format.clone()).expect("Failed to create encoder");
    let mut decoded_count = 0;
    let mut encoded_count = 0;
    let mut total_encoded_bytes = 0;
    let start = Instant::now();

    while start.elapsed() < Duration::from_secs(3) {
        match decoder.decode_resampled(&format, frames_per_packet) {
            Ok(Some(frame)) => {
                decoded_count += 1;

                // Verify audio isn't silent
                let rms = calculate_rms(&frame.samples);
                if decoded_count <= 5 || decoded_count % 20 == 0 {
                    println!("Frame {}: {} samples, RMS={:.1}", decoded_count, frame.samples.len(), rms);
                }

                // Encode
                match encoder.encode(&frame.samples) {
                    Ok(packet) => {
                        encoded_count += 1;
                        total_encoded_bytes += packet.data.len();
                    }
                    Err(e) => println!("Encode error: {}", e),
                }
            }
            Ok(None) => {
                // No data yet, brief sleep
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => {
                println!("Decode error: {}", e);
                break;
            }
        }

        if decoded_count >= 200 {
            break;
        }
    }

    stop.store(true, Ordering::Relaxed);
    capture_thread.join().unwrap();

    let sent = frames_sent.load(Ordering::Relaxed);
    println!("\nResults:");
    println!("  Capture: {} periods sent", sent);
    println!("  Decoder: {} packets decoded", decoded_count);
    println!("  Encoder: {} packets encoded ({} bytes)", encoded_count, total_encoded_bytes);

    // Validate results
    assert!(sent > 50, "Capture sent too few periods: {}", sent);
    assert!(decoded_count > 100, "Decoded too few packets: {}", decoded_count);
    assert_eq!(decoded_count, encoded_count, "Decode/encode mismatch");
}

#[test]
fn test_buffer_integration() {
    println!("\n=== Test: Full Buffer Integration ===");

    let (sender, mut decoder) = LiveAudioDecoder::create_pair(44100, 2, 16);
    decoder.set_recv_timeout(Duration::from_millis(50));

    let format = test_format();
    let frames_per_packet = format.frames_per_packet as usize;

    // Create audio buffer (like AudioStreamer uses)
    let mut buffer = AudioBuffer::new(format.clone(), 2000); // 2 second buffer

    let stop = Arc::new(AtomicBool::new(false));
    let frames_sent = Arc::new(AtomicU64::new(0));

    // Spawn capture simulator
    let stop_clone = Arc::clone(&stop);
    let frames_sent_clone = Arc::clone(&frames_sent);
    let capture_thread = thread::spawn(move || {
        simulate_pipewire_capture(sender, stop_clone, frames_sent_clone, 1.5);
    });

    // Decode and buffer loop
    let start = Instant::now();
    let mut frames_buffered = 0;

    while start.elapsed() < Duration::from_secs(2) {
        // Decode into buffer (like decode_some_inner)
        for _ in 0..5 {
            match decoder.decode_resampled(&format, frames_per_packet) {
                Ok(Some(frame)) => {
                    let audio_frame = AudioFrame::new(frame.samples, frame.timestamp);
                    if buffer.push(audio_frame).is_ok() {
                        frames_buffered += 1;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    println!("Decode error: {}", e);
                    break;
                }
            }
        }

        // Simulate consumption (like streamer send loop)
        if buffer.len() > 10 {
            for _ in 0..3 {
                if buffer.pop().is_some() {
                    // Would send via RTP here
                }
            }
        }

        thread::sleep(Duration::from_millis(8)); // ~frame duration
    }

    stop.store(true, Ordering::Relaxed);
    capture_thread.join().unwrap();

    println!("Buffered {} frames, {} remaining in buffer", frames_buffered, buffer.len());
    assert!(frames_buffered > 100, "Too few frames buffered: {}", frames_buffered);
}

#[test]
fn test_continuous_streaming_simulation() {
    println!("\n=== Test: Continuous Streaming Simulation (like TUI) ===");

    // This test simulates the full TUI -> Streamer flow
    let format = test_format();
    let frames_per_packet = format.frames_per_packet as usize;

    // Shared state (like BtCaptureShared in TUI)
    let capture_running = Arc::new(AtomicBool::new(true));
    let total_captured = Arc::new(AtomicU64::new(0));
    let total_encoded = Arc::new(AtomicU64::new(0));

    // Create live decoder pair
    // CRITICAL: Use a very short timeout so the streamer loop doesn't block
    // waiting for data. The streamer should keep running even with no data.
    let (sender, mut decoder) = LiveAudioDecoder::create_pair(44100, 2, 16);
    decoder.set_recv_timeout(Duration::from_millis(5)); // Short timeout!

    // Capture thread (like bt-capture thread in TUI)
    let capture_running_clone = Arc::clone(&capture_running);
    let total_captured_clone = Arc::clone(&total_captured);
    let capture_thread = thread::spawn(move || {
        let sample_rate = 44100u32;
        let period_frames = 1024usize;
        let period_duration = Duration::from_secs_f64(period_frames as f64 / sample_rate as f64);

        while capture_running_clone.load(Ordering::Relaxed) {
            let samples = generate_sine_wave(440.0, sample_rate, period_frames);
            let frame = LivePcmFrame {
                samples,
                channels: 2,
                sample_rate,
            };

            if sender.try_send(frame) {
                total_captured_clone.fetch_add(1, Ordering::Relaxed);
            }

            thread::sleep(period_duration);
        }
    });

    // Streamer thread (like AudioStreamer)
    let capture_running_clone2 = Arc::clone(&capture_running);
    let total_encoded_clone = Arc::clone(&total_encoded);
    let total_decoded = Arc::new(AtomicU64::new(0));
    let total_decoded_clone = Arc::clone(&total_decoded);
    let decode_nones = Arc::new(AtomicU64::new(0));
    let decode_nones_clone = Arc::clone(&decode_nones);
    let streamer_thread = thread::spawn(move || {
        let mut encoder = create_encoder(format.clone()).expect("Failed to create encoder");
        let mut buffer = AudioBuffer::new(format.clone(), 2000);

        let frame_duration = Duration::from_secs_f64(frames_per_packet as f64 / 44100.0);
        let mut next_send = Instant::now();
        let mut loops = 0u64;

        while capture_running_clone2.load(Ordering::Relaxed) {
            loops += 1;

            // Decode into buffer - ALWAYS try to decode, not just when < 60%
            for _ in 0..5 {
                match decoder.decode_resampled(&format, frames_per_packet) {
                    Ok(Some(frame)) => {
                        let audio_frame = AudioFrame::new(frame.samples, frame.timestamp);
                        let _ = buffer.push(audio_frame);
                        total_decoded_clone.fetch_add(1, Ordering::Relaxed);
                    }
                    Ok(None) => {
                        decode_nones_clone.fetch_add(1, Ordering::Relaxed);
                        break;
                    }
                    Err(_) => break,
                }
            }

            // Send at frame rate (run_streamer equivalent)
            if Instant::now() >= next_send {
                if let Some(frame) = buffer.pop() {
                    match encoder.encode(&frame.samples) {
                        Ok(_packet) => {
                            total_encoded_clone.fetch_add(1, Ordering::Relaxed);
                            // Would send via RTP here
                        }
                        Err(e) => println!("Encode error: {}", e),
                    }
                }
                next_send += frame_duration;
            } else {
                thread::sleep(Duration::from_millis(1));
            }
        }

        println!("  Streamer loops: {}", loops);
        println!("  Buffer remaining: {} frames", buffer.len());
    });

    // Let it run for 2 seconds
    thread::sleep(Duration::from_secs(2));
    capture_running.store(false, Ordering::Relaxed);

    capture_thread.join().unwrap();
    streamer_thread.join().unwrap();

    let captured = total_captured.load(Ordering::Relaxed);
    let decoded = total_decoded.load(Ordering::Relaxed);
    let nones = decode_nones.load(Ordering::Relaxed);
    let encoded = total_encoded.load(Ordering::Relaxed);

    println!("\nFinal Results:");
    println!("  Captured: {} periods ({} samples)", captured, captured * 1024);
    println!("  Decoded:  {} packets ({} samples)", decoded, decoded * 352);
    println!("  Decode timeouts (None): {}", nones);
    println!("  Encoded:  {} packets ({} samples)", encoded, encoded * 352);

    // At 44100Hz:
    // - 2 seconds = 88200 samples
    // - Capture periods (1024 samples) = ~86 periods
    // - Encode packets (352 samples) = ~250 packets
    assert!(captured >= 70, "Captured too few periods: {}", captured);
    assert!(encoded >= 200, "Encoded too few packets: {}", encoded);

    // Check that we're encoding at roughly the right rate
    let expected_packets = (2.0 * 44100.0 / 352.0) as u64; // ~250
    let ratio = encoded as f64 / expected_packets as f64;
    println!("  Encode rate: {:.1}% of expected", ratio * 100.0);
    assert!(ratio > 0.8, "Encode rate too low: {:.1}%", ratio * 100.0);
}
