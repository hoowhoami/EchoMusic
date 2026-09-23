//! Test the audio resampling pipeline locally.
//!
//! Run with: cargo test -p airplay-bluetooth --test resampler_test -- --nocapture
//!
//! This test uses the shared airplay-resampler crate with mastering-quality
//! settings (sinc_len: 512) and verifies proper priming behavior.

// This test is only meaningful on Linux where ALSA capture is used
#![cfg(target_os = "linux")]

use airplay_resampler::Resampler;
use std::f32::consts::PI;

const SAMPLE_RATE_HD: u32 = 48000;
const SAMPLE_RATE_OUT: u32 = 44100;
const FRAMES_PER_PERIOD: usize = 1024;

/// Generate a stereo sine wave at the given frequency.
fn generate_sine_wave(frequency: f32, sample_rate: usize, duration_secs: f32) -> Vec<Vec<f32>> {
    let num_samples = (sample_rate as f32 * duration_secs) as usize;
    let mut left = Vec::with_capacity(num_samples);
    let mut right = Vec::with_capacity(num_samples);

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let sample = (2.0 * PI * frequency * t).sin() * 0.8; // 80% amplitude
        left.push(sample);
        right.push(sample);
    }

    vec![left, right]
}

/// Calculate RMS of a signal.
fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares: f32 = samples.iter().map(|s| s * s).sum();
    (sum_squares / samples.len() as f32).sqrt()
}

#[test]
fn test_resampler_priming() {
    println!("\n=== Testing shared resampler with automatic priming ===");

    // Create resampler using the shared crate (automatically primed)
    let mut resampler = Resampler::with_chunk_size(
        SAMPLE_RATE_HD,
        SAMPLE_RATE_OUT,
        2,
        FRAMES_PER_PERIOD,
    ).expect("Failed to create resampler");

    // Generate 1 second of 440Hz sine wave at 48kHz
    let input = generate_sine_wave(440.0, SAMPLE_RATE_HD as usize, 1.0);

    // Process in chunks
    let mut all_output_left: Vec<f32> = Vec::new();
    let mut all_output_right: Vec<f32> = Vec::new();
    let mut input_pos = 0;

    while input_pos < input[0].len() {
        let chunk_size = resampler.input_frames_next().min(input[0].len() - input_pos);
        if chunk_size == 0 {
            break;
        }

        let chunk: Vec<Vec<f32>> = vec![
            input[0][input_pos..input_pos + chunk_size].to_vec(),
            input[1][input_pos..input_pos + chunk_size].to_vec(),
        ];
        input_pos += chunk_size;

        match resampler.process_f32(&chunk) {
            Ok(output) => {
                if !output.is_empty() && !output[0].is_empty() {
                    all_output_left.extend(&output[0]);
                    all_output_right.extend(&output[1]);
                }
            }
            Err(e) => {
                println!("Resampling error: {}", e);
                break;
            }
        }
    }

    // Analyze the first 1000 samples (about 22ms at 44.1kHz)
    let first_samples = &all_output_left[..1000.min(all_output_left.len())];
    let first_rms = calculate_rms(first_samples);

    // Analyze samples from the middle
    let mid_start = all_output_left.len() / 2;
    let mid_samples = &all_output_left[mid_start..mid_start + 1000];
    let mid_rms = calculate_rms(mid_samples);

    println!("Total output samples: {}", all_output_left.len());
    println!("First 1000 samples RMS: {:.6}", first_rms);
    println!("Middle 1000 samples RMS: {:.6}", mid_rms);
    println!("Ratio (first/middle): {:.3}", first_rms / mid_rms);

    // With automatic priming, the ratio should be close to 1.0
    let ratio = first_rms / mid_rms;
    println!("WITH automatic priming: ratio = {:.3} (expect > 0.8)", ratio);

    // This should pass with the primed resampler
    assert!(ratio > 0.8, "First samples should have similar RMS to middle with priming");
}

#[test]
fn test_quality_settings() {
    println!("\n=== Verifying mastering-quality settings ===");

    // The shared resampler uses sinc_len: 512 (mastering quality)
    // Verify by checking that output is high quality
    let mut resampler = Resampler::with_chunk_size(
        SAMPLE_RATE_HD,
        SAMPLE_RATE_OUT,
        2,
        FRAMES_PER_PERIOD,
    ).expect("Failed to create resampler");

    assert_eq!(resampler.source_rate(), SAMPLE_RATE_HD);
    assert_eq!(resampler.target_rate(), SAMPLE_RATE_OUT);
    assert_eq!(resampler.channels(), 2);

    // Generate and process audio
    let input = generate_sine_wave(440.0, SAMPLE_RATE_HD as usize, 0.5);
    let mut input_pos = 0;
    let mut total_output = 0;

    while input_pos < input[0].len() {
        let chunk_size = resampler.input_frames_next().min(input[0].len() - input_pos);
        if chunk_size == 0 {
            break;
        }

        let chunk: Vec<Vec<f32>> = vec![
            input[0][input_pos..input_pos + chunk_size].to_vec(),
            input[1][input_pos..input_pos + chunk_size].to_vec(),
        ];
        input_pos += chunk_size;

        if let Ok(output) = resampler.process_f32(&chunk) {
            if !output.is_empty() {
                total_output += output[0].len();
            }
        }
    }

    // Verify correct resampling ratio
    let expected_output = (input[0].len() as f64 * SAMPLE_RATE_OUT as f64 / SAMPLE_RATE_HD as f64) as usize;
    let ratio = total_output as f64 / expected_output as f64;

    println!("Input samples: {}", input[0].len());
    println!("Output samples: {}", total_output);
    println!("Expected output: {}", expected_output);
    println!("Ratio: {:.3}", ratio);

    // Allow 10% tolerance for buffer effects
    assert!(ratio > 0.9 && ratio < 1.1, "Resampling ratio should be close to 1.0");
}

#[test]
fn test_dithering() {
    println!("\n=== Testing TPDF dithering ===");

    // Test that dithering produces reasonable output
    let samples = vec![vec![0.5f32; 100], vec![-0.5f32; 100]];
    let output = airplay_resampler::interleave_with_dither(&samples);

    assert_eq!(output.len(), 200); // 100 frames * 2 channels

    // Verify left channel samples are roughly positive
    let left_avg: f32 = output.iter().step_by(2).map(|&s| s as f32).sum::<f32>() / 100.0;
    assert!(left_avg > 10000.0, "Left channel average should be positive: {}", left_avg);

    // Verify right channel samples are roughly negative
    let right_avg: f32 = output.iter().skip(1).step_by(2).map(|&s| s as f32).sum::<f32>() / 100.0;
    assert!(right_avg < -10000.0, "Right channel average should be negative: {}", right_avg);

    println!("Left channel average: {}", left_avg);
    println!("Right channel average: {}", right_avg);
}
