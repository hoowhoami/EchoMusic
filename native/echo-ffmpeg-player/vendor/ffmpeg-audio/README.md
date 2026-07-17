# ffmpeg-audio

A lightweight FFmpeg audio decoding wrapper designed for music player applications.

## Features

* Simple and intuitive API
* Pure Rust compilation via [cc](https://github.com/rust-lang/cc-rs) — no C build system required
* Fully statically linked with zero external FFmpeg dependencies
* Bundled with a specific, up-to-date FFmpeg version (currently 8.1.2)
* Optional `tracing` feature for FFmpeg log integration

## Supported Audio Formats

This crate leverages FFmpeg's decoding capabilities and supports almost all audio formats, including:

* MP3, AAC, FLAC, WAV, OGG, Opus, WMA, ALAC, AIFF, and more

You can find the complete list in [generate_config.ts](./scripts/generate_config.ts)

## Supported Sample Formats

The resampler output supports the following Rust-native sample types:

| Type  | FFmpeg Format  |
| ----- | -------------- |
| `f32` | 32-bit Float   |
| `i16` | 16-bit Signed  |
| `i32` | 32-bit Signed  |
| `u8`  | 8-bit Unsigned |

## Usage

```toml
[dependencies]
ffmpeg_audio = { git = "https://github.com/apoint123/ffmpeg-audio" }

```

```rust
use std::fs::File;
use ffmpeg_audio::{AudioReader, ResampleOptions};

// 1. Initialize the decoding engine
let reader = AudioReader::new(File::open("song.mp3")?)?;

// 2. Configure target audio parameters (e.g., 48kHz, Stereo, 32-bit Float)
let options = ResampleOptions::new()
    .sample_rate(48000)
    .channels(2)
    .format::<f32>();

// 3. Transform into a resampled data pipeline
let mut resampled = reader.into_resampled(options)?;

// 4. Safely pull typed audio frames
while let Some(samples) = resampled.receive_frame_as::<f32>()? {
    // `samples` is strictly typed as &[f32]
    // process your interleaved samples here
}

```

## Supported Platforms

This crate covers **all Rust [Tier 1](https://doc.rust-lang.org/rustc/platform-support.html#tier-1-with-host-tools) targets** and most mainstream Tier 2 targets. Highlights include:

* **Windows** — MSVC & GNU toolchains (`x86_64`, `x86`, `aarch64`, `arm`)
* **Linux / BSD** — `x86_64`, `x86`, `aarch64`, `armv7` (including FreeBSD, NetBSD, OpenBSD, and more)
* **macOS** — `x86_64` & `aarch64`
* **iOS / tvOS / watchOS / visionOS** — `aarch64` (device & simulator), `x86_64` (simulator)
* **Android** — `aarch64`, `armv7`, `x86`, `x86_64`
* **WebAssembly** — `wasm32-unknown-emscripten` (note: `wasm32-unknown-unknown` is **not** supported)

For the full list of supported target triples, see [`get_config_dir_name()`](./crates/ffmpeg_audio_sys/build.rs).

> [!WARNING]
> Building for a target triple not listed in [`get_config_dir_name()`](./crates/ffmpeg_audio_sys/build.rs) might fail at compile time, or cause a runtime UB.

## Examples

The `crates/ffmpeg_audio/examples` directory contains runnable examples:

* **`play.rs`** — A complete audio player using `cpal` for audio output
* **`metadata.rs`** — Extracts audio metadata and cover art from files

Run an example with:

```sh
cargo run --example play -- path/to/audio.mp3
cargo run --example metadata -- path/to/audio.flac
```

## WebAssembly (Emscripten) Build

To build for `wasm32-unknown-emscripten`, install the following prerequisites:

1. **Emscripten SDK (emsdk)** — Follow the [official installation guide](https://emscripten.org/docs/getting_started/downloads.html). After installation, make sure `emcc` is in your `PATH`.

2. **Rust target**:
   ```sh
   rustup target add wasm32-unknown-emscripten
   ```

3. **libclang** — Required by [bindgen](https://github.com/rust-lang/rust-bindgen) to generate C bindings. Most systems already have it; Emscripten SDK also ships one.

Then build as usual:

```sh
cargo build --target wasm32-unknown-emscripten --release
```

The output (a `.js` + `.wasm` pair) can be run with Node.js:

```sh
node target/wasm32-unknown-emscripten/release/your_app.js
```

## Limitations

This crate focuses solely on audio decoding. The following features are not included:

* Video processing
* Encoders, muxers, and filters
* Swscale (video scaling/conversion)
* Hardware acceleration
* Device and network protocol support

## License

[GPL 3.0](LICENSE)
