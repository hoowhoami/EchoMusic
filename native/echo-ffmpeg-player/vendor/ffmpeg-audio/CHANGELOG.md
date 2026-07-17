# Changelog

All notable changes to `ffmpeg_audio` and `ffmpeg_audio_sys` will be documented in this file.

## [Unreleased]

<!-- Changes not yet released go here -->

---

## [0.1.2] - 2026-07-14

### ffmpeg_audio

- **Added** `Send` implementation for `ChannelLayout`, enabling it to be safely transferred across threads.
- **Added** `Sync` implementation for `ChannelLayout`, enabling shared references across threads.
- **Added** `Send` implementation for `Resampler`, enabling it to be safely transferred across threads.

### ffmpeg_audio_sys

- No functional changes in this release (version bump only).

---

## [0.1.1] - 2026-07-14

### ffmpeg_audio

- **Changed** package description from "High-level Rust audio processing, decoding, and resampling engine based on FFmpeg." to "A lightweight FFmpeg audio decoding wrapper designed for music player applications."

### ffmpeg_audio_sys

- **Changed** package description from "Raw FFI bindings for FFmpeg audio processing." to "Raw FFmpeg FFI bindings for ffmpeg_audio."

---

## [0.1.0] - 2026-07-14

### ffmpeg_audio

- Initial release of the high-level audio decoding and resampling crate built on top of `ffmpeg_audio_sys`.

### ffmpeg_audio_sys

- Initial release of raw FFmpeg FFI bindings.

[unreleased]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apoint123/ffmpeg-audio/releases/tag/v0.1.0
