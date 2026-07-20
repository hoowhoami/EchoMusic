# soundtouch-rs

A pure Rust implementation of the [SoundTouch](https://www.surina.net/soundtouch/) audio processing library, providing tempo, pitch, and playback rate adjustment for PCM audio streams.

## Features

- **Tempo adjustment** — Change playback speed without affecting pitch (time-stretching via WSOLA)
- **Pitch adjustment** — Shift pitch in semitones or ratio without changing duration
- **Rate adjustment** — Uniform speed + pitch change (classic playback rate)
- **Builder pattern API** — Fluent configuration with presets for music and speech
- **Multiple interpolation algorithms** — Linear, Cubic (default), and Shannon (windowed sinc)
- **Anti-aliasing filter** — Configurable low-pass FIR filter for pitch shifting quality
- **Multi-channel support** — Mono, stereo, and beyond
- **SIMD acceleration** — Uses the `wide` crate for vectorized sample processing

## Installation

```toml
[dependencies]
soundtouch-rs = "0.1.0"
```

## Quick Start

```rust
use soundtouch_rs::SoundTouch;

// Create a processor: 2 channels, 44100 Hz
let mut st = SoundTouch::builder(2, 44100)
    .tempo(1.5)             // 1.5x speed, pitch unchanged
    .pitch_semi_tones(2.0)  // +2 semitones
    .build()?;

// Feed interleaved i16 samples (stereo: L, R, L, R, ...)
let input: &[i16] = &[/* ... */];
st.put_samples_i16(input);

// Retrieve processed samples
let mut output = vec![0i16; 4096];
let received = st.receive_samples_i16(&mut output);
```

## Presets

```rust
use soundtouch_rs::{SoundTouch, SoundTouchPreset};

// Optimized for speech / podcasts (shorter windows, reduces robotic echo)
let mut st = SoundTouch::builder(1, 16000)
    .preset(SoundTouchPreset::Speech)
    .build()?;

// Custom WSOLA parameters (in milliseconds)
let mut st = SoundTouch::builder(2, 44100)
    .preset(SoundTouchPreset::Custom {
        sequence_ms: 40,
        seek_window_ms: 15,
        overlap_ms: 8,
    })
    .build()?;
```

## Interpolation Algorithms

| Algorithm | Quality | Latency  | Method                      |
| --------- | ------- | -------- | --------------------------- |
| `Linear`  | Low     | 0 frames | Two-point linear blend      |
| `Cubic`   | Medium  | 1 frame  | 4-point Hermite spline      |
| `Shannon` | High    | 3 frames | Windowed 16-tap sinc filter |

```rust
use soundtouch_rs::{SoundTouch, InterpolationAlgorithm};

let st = SoundTouch::builder(2, 44100)
    .interpolation_algo(InterpolationAlgorithm::Shannon)
    .build()?;
```

## Example

A real-time playback example is included that reads an audio file via [ffmpeg-audio](https://github.com/apoint123/ffmpeg-audio) and plays it through `cpal`:

```sh
cargo run --example play -- path/to/music.mp3 --tempo 1.5 --pitch 2.0
```

## Benchmarks

```sh
cargo bench
```

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).
