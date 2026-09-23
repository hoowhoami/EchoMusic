# Audio Resampling in AirPlay 2

This document explains the audio resampling methods used in the project and how to achieve the highest quality audio output.

## Overview

AirPlay 2 streams audio at **44.1 kHz** (CD quality). When the source audio is at a different sample rate (e.g., 48 kHz from Bluetooth HD codecs, or various rates from audio files), it must be resampled.

The project currently has two resampling implementations:

| Location | Method | Quality | Use Case |
|----------|--------|---------|----------|
| `airplay-audio` (decoder.rs, live_decoder.rs) | Linear interpolation | Low | File playback, general streaming |
| `airplay-bluetooth` (alsa_capture.rs) | Sinc interpolation (rubato) | Audiophile | Bluetooth HD capture |

## Resampling Methods Explained

### 1. Linear Interpolation (Current Default)

**Location:** `crates/airplay-audio/src/decoder.rs:437-472`

```rust
fn resample_linear(samples, channels, source_rate, target_rate) -> Vec<i16>
```

**How it works:**
- Calculates the position of each output sample in the source signal
- Interpolates between two adjacent source samples using a weighted average
- Fast and simple, but introduces aliasing artifacts

**Pros:**
- Very fast (~O(n) with minimal operations)
- No external dependencies
- Low memory usage

**Cons:**
- Introduces **aliasing artifacts** (high frequencies fold back as distortion)
- No anti-aliasing filter
- Audible quality degradation, especially with music containing high frequencies
- ~60 dB signal-to-noise ratio at best

**When to use:**
- Quick prototyping
- CPU-constrained environments where quality isn't critical
- Speech or simple audio content

### 2. Sinc Interpolation with Rubato (High Quality)

**Location:** `crates/airplay-bluetooth/src/alsa_capture.rs:327-528`

**How it works:**
1. Uses a **windowed sinc filter** (the mathematically ideal reconstruction filter)
2. Applies an anti-aliasing lowpass filter before downsampling
3. Uses polyphase filter implementation for efficiency
4. Processes audio in deinterleaved floating-point format for precision

**Current configuration:**
```rust
let sinc_params = SincInterpolationParameters {
    sinc_len: 256,                                // Filter length (taps)
    f_cutoff: 0.95,                               // Anti-alias cutoff (0.95 = 95% of Nyquist)
    interpolation: SincInterpolationType::Cubic,  // Interpolation between sinc points
    oversampling_factor: 256,                     // Internal oversampling
    window: WindowFunction::BlackmanHarris2,      // Excellent stopband attenuation
};
```

**Pros:**
- Near-transparent audio quality (~140 dB SNR possible)
- Proper anti-aliasing prevents folding artifacts
- Preserves high-frequency content up to `f_cutoff` of Nyquist
- Mathematically optimal reconstruction

**Cons:**
- Higher CPU usage (~10-50x more than linear)
- Requires external dependency (`rubato` crate)
- Introduces latency (filter needs to "prime")
- More complex to integrate

## Quality Comparison

| Metric | Linear | Sinc (current config) |
|--------|--------|----------------------|
| Signal-to-Noise Ratio | ~60 dB | ~140 dB |
| Aliasing artifacts | Present | Eliminated |
| High-frequency preservation | Poor | Excellent (to 0.95× Nyquist) |
| Transient response | Smeared | Clean |
| CPU usage (per second of audio) | ~1 ms | ~10-50 ms |
| Latency (samples) | 0 | ~256 samples (~6 ms) |

## Rubato Configuration Parameters

### `sinc_len` (Filter Length)
Number of zero-crossings of the sinc function on each side. Higher = better quality but more CPU.

| Value | Quality | Use Case |
|-------|---------|----------|
| 64 | Good | Real-time with limited CPU |
| 128 | Very Good | Most applications |
| 256 | Excellent | Audiophile/studio quality |
| 512 | Maximum | Archival/mastering |

**Recommendation:** 256 for AirPlay (our current setting)

### `f_cutoff` (Anti-aliasing Cutoff)
Fraction of the Nyquist frequency to preserve. Higher preserves more high frequencies but risks aliasing.

| Value | Behavior |
|-------|----------|
| 0.90 | Conservative, maximum aliasing rejection |
| 0.95 | Balanced (our current setting) |
| 0.97 | Aggressive, may have slight aliasing |

**Recommendation:** 0.95 (preserves frequencies up to ~21 kHz at 44.1 kHz output)

### `interpolation` (Sub-sample Interpolation)
Method for interpolating between precomputed sinc table values:

| Type | Quality | Speed |
|------|---------|-------|
| `Nearest` | Lowest | Fastest |
| `Linear` | Good | Fast |
| `Cubic` | Excellent | Moderate |

**Recommendation:** `Cubic` for best quality (our current setting)

### `oversampling_factor`
Internal oversampling to reduce interpolation error. Higher = better quality.

| Value | Notes |
|-------|-------|
| 64 | Minimum recommended |
| 128 | Good quality |
| 256 | Excellent quality (our current setting) |

### `window` (Window Function)
The window applied to the sinc function affects stopband attenuation:

| Window | Stopband | Main Lobe |
|--------|----------|-----------|
| `Hann` | -44 dB | Narrow |
| `Hamming` | -53 dB | Narrow |
| `Blackman` | -74 dB | Medium |
| `BlackmanHarris` | -92 dB | Wide |
| `BlackmanHarris2` | -107 dB | Wide |

**Recommendation:** `BlackmanHarris2` for maximum aliasing rejection (our current setting)

## TPDF Dithering

When converting from floating-point back to 16-bit integer, the Bluetooth capture applies **TPDF (Triangular Probability Density Function) dithering**:

```rust
let rand1 = fastrand::f32() - 0.5;
let rand2 = fastrand::f32() - 0.5;
let tpdf_noise = (rand1 + rand2) / 32768.0;
let dithered = sample_f32 + tpdf_noise;
```

**Why dithering matters:**
- Quantization (float→int) introduces correlated distortion
- Dithering replaces this with uncorrelated noise
- TPDF specifically eliminates noise modulation (the noise floor is constant)
- Results in lower perceived noise and cleaner audio

## Priming the Resampler

Sinc resamplers have inherent latency due to their filter length. The first output samples will be incorrect (ramping up from silence) unless the resampler is "primed":

```rust
// Calculate priming chunks needed
let output_delay = resampler.output_delay();
let priming_chunks = (512 / input_frames_needed).max(3);

// Feed silence to fill internal buffers
let silence_chunk: Vec<Vec<f32>> = (0..channels)
    .map(|_| vec![0.0f32; input_frames_needed])
    .collect();

for _ in 0..priming_chunks {
    resampler.process(&silence_chunk, None)?;
}
```

**Without priming:** First ~5-10 ms of audio will fade in (audible click/pop)
**With priming:** Clean audio from the first sample

## Upgrading airplay-audio to High-Quality Resampling

To upgrade the file decoder and live decoder to use rubato:

### 1. Add dependency to `crates/airplay-audio/Cargo.toml`:

```toml
[dependencies]
rubato = "0.15"
fastrand = "2.0"  # For TPDF dithering
```

### 2. Create a resampler wrapper:

```rust
// crates/airplay-audio/src/resampler.rs

use rubato::{SincFixedIn, SincInterpolationParameters, SincInterpolationType,
             WindowFunction, Resampler};

pub struct HighQualityResampler {
    resampler: SincFixedIn<f32>,
    channels: usize,
}

impl HighQualityResampler {
    pub fn new(source_rate: u32, target_rate: u32, channels: u8, chunk_size: usize) -> Self {
        let sinc_params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Cubic,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };

        let mut resampler = SincFixedIn::<f32>::new(
            target_rate as f64 / source_rate as f64,
            2.0,
            sinc_params,
            chunk_size,
            channels as usize,
        ).expect("Failed to create resampler");

        // Prime the resampler
        let input_frames = resampler.input_frames_next();
        let silence: Vec<Vec<f32>> = (0..channels)
            .map(|_| vec![0.0f32; input_frames])
            .collect();
        for _ in 0..3 {
            let _ = resampler.process(&silence, None);
        }

        Self { resampler, channels: channels as usize }
    }

    pub fn process(&mut self, samples: &[i16]) -> Vec<i16> {
        // Deinterleave and convert to f32
        let frames = samples.len() / self.channels;
        let mut input: Vec<Vec<f32>> = (0..self.channels)
            .map(|_| Vec::with_capacity(frames))
            .collect();

        for frame in 0..frames {
            for ch in 0..self.channels {
                let sample = samples[frame * self.channels + ch];
                input[ch].push(sample as f32 / 32768.0);
            }
        }

        // Resample
        let output = match self.resampler.process(&input, None) {
            Ok(out) => out,
            Err(_) => return vec![],
        };

        if output.is_empty() || output[0].is_empty() {
            return vec![];
        }

        // Convert back to i16 with TPDF dithering and interleave
        let out_frames = output[0].len();
        let mut result = Vec::with_capacity(out_frames * self.channels);

        for frame in 0..out_frames {
            for ch in 0..self.channels {
                let sample = output[ch][frame];

                // TPDF dithering
                let r1 = fastrand::f32() - 0.5;
                let r2 = fastrand::f32() - 0.5;
                let dither = (r1 + r2) / 32768.0;

                let dithered = ((sample + dither) * 32767.0)
                    .clamp(-32768.0, 32767.0) as i16;
                result.push(dithered);
            }
        }

        result
    }
}
```

### 3. Replace linear resampling calls:

In `decoder.rs` and `live_decoder.rs`, replace:
```rust
let resampled = resample_linear(&frame.samples, frame.channels, source_rate, target_rate);
```

With:
```rust
let resampled = self.resampler.process(&frame.samples);
```

## Performance Considerations

### CPU Usage
High-quality resampling uses significantly more CPU. On a Raspberry Pi:
- Linear: ~0.5% CPU per stream
- Sinc (256 taps): ~5-15% CPU per stream

### Memory Usage
The sinc resampler requires:
- Filter coefficients: ~`sinc_len × oversampling_factor × 4` bytes
- Internal buffers: ~`sinc_len × channels × 8` bytes
- Total: ~300 KB for our configuration

### Latency
The sinc filter introduces `sinc_len / 2` samples of latency:
- At 256 taps, 44.1 kHz: ~2.9 ms
- This is handled by the AirPlay render delay buffer

## Testing Audio Quality

The project includes a resampler test that generates WAV files for manual listening:

```bash
cargo test -p airplay-bluetooth --test resampler_test -- --nocapture
```

This creates:
- `/tmp/resampler_no_priming.wav` - Demonstrates startup distortion
- `/tmp/resampler_with_priming.wav` - Clean audio from start

Listen for:
- High-frequency clarity (cymbals, high harmonics)
- Transient response (drum attacks)
- Background noise level
- Aliasing artifacts (metallic distortion)

## References

- [Rubato documentation](https://docs.rs/rubato/latest/rubato/)
- [Digital Audio Resampling Home Page](https://ccrma.stanford.edu/~jos/resample/)
- [TPDF Dithering explained](https://en.wikipedia.org/wiki/Dither#Digital_audio)
- [Window Functions comparison](https://en.wikipedia.org/wiki/Window_function)
