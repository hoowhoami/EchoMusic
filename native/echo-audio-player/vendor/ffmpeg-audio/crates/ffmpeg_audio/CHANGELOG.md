# ffmpeg_audio

## 0.4.0

### Minor Changes

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Removed** the public `TimeBase` type and the `core::time` module. Timestamp handling is now internal to the crate.

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Changed** `scan_exact_duration` to return the exact duration measured from zero: the time right after the last sample, rather than the span between the earliest and the latest timestamp found while scanning.

- [#13](https://github.com/apoint123/ffmpeg-audio/pull/13) [`0dff143`](https://github.com/apoint123/ffmpeg-audio/commit/0dff143bfd9b9b8b11436882970559d930a49ef0) Thanks [@apoint123](https://github.com/apoint123)! - **Updated** bundled FFmpeg from 8.1.2 to 9.0.2 (libavcodec 63, libavformat 63, libavutil 61, libswresample 7). APIs removed upstream in this major release (e.g. `AVCodecContext.properties`, the private fields of `AVCodecParser`, `AVTimebaseSource`) are no longer available in the generated bindings.

### Patch Changes

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Documented** that `SeekMode::Coarse` and `SeekMode::Accurate` start at the nearest reachable position when the container cannot reach positions before the target, and that `AudioReader::duration` returns the duration declared by the container, which is an estimate.

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Changed** timestamps and durations (`AudioFrame::pts`, `AudioFrame::duration`, `stream_position`, `scan_exact_duration`) to be computed exactly and rounded down to whole nanoseconds, instead of being rounded to microseconds at every step. Seeking to a reported timestamp now lands on the same sample again.

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Fixed** accurate seeking discarding the preroll trim of the frame it lands on, which could deliver preroll samples when seeking close to the start of a stream with negative timestamps.

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Fixed** accurate seeking trimming one sample too many when a frame timestamp is not a whole number of microseconds (e.g. seeking to 100 ms in a 48 kHz AAC stream now starts exactly at 100 ms instead of 100.02 ms).

- [`6676910`](https://github.com/apoint123/ffmpeg-audio/commit/6676910472a059443a25bfd7547c5298a9a1d516) Thanks [@apoint123](https://github.com/apoint123)! - **Fixed** `scan_exact_duration` disturbing reading: after a coarse seek it moved reading back to the start, and mid-stream it could drop samples (e.g. 16 samples in Matroska files, whose timestamps are rounded to milliseconds) or shift frame boundaries. Reading now continues with exactly the frames it would have delivered, and `stream_position` keeps its value until the next frame.

- [`6d7e7dc`](https://github.com/apoint123/ffmpeg-audio/commit/6d7e7dcce4073ba62176049d7e88d3514dc24919) Thanks [@apoint123](https://github.com/apoint123)! - **Fixed** `scan_exact_duration` under-reporting the duration of streams whose first samples cannot be reached by seeking (e.g. 892.666 ms instead of 899.667 ms for a Matroska file with negative timestamps), and reporting a 2 s WAV file as 1.999999 s.
- Updated dependencies [[`2876aba`](https://github.com/apoint123/ffmpeg-audio/commit/2876abacdfb26eb01ce1b5af343392baba8d0be6), [`2876aba`](https://github.com/apoint123/ffmpeg-audio/commit/2876abacdfb26eb01ce1b5af343392baba8d0be6)]:
  - ffmpeg_audio_sys@0.2.0

## [0.3.1] - 2026-08-05

### Refactored

- **Refactored** HTTP reconnection handling to automatically reconnect when the server closes the connection unexpectedly, using bounded exponential backoff.
- **Refactored** HTTP range request validation to verify the `Content-Range` start offset and total length for the initial request and subsequent seeks or reconnects.

## [0.3.0] - 2026-08-05

### Breaking Changes

- **Changed** HTTP cancellation to use the new thread-safe, opaque `HttpCancelHandle` API.
- **Removed** `HttpAudioSource::new_with_token`; use `HttpAudioSource::new_with_cancel_handle` instead.

### Added

- **Added** `HttpCancelHandle::cancel`, `reset`, and `is_cancelled` for controlling cancellation and reusing an HTTP audio source.

### Fixed

- **Fixed** cancellation behavior so ongoing network operations can be interrupted immediately and subsequent operations can continue after resetting the handle.

## [0.2.0] - 2026-07-21

### Breaking Changes

- **Changed** log feature to be disabled by default.

### Added

- **Added** API to get raw PCM data directly, bypassing the resampler.

### Refactored

- **Refactored** HTTP stream implementation using `tokio` and `reqwest` to support cancellation at any point.
- **Refactored** negative PTS handling to be unified across the codebase.
- **Refactored** stream scanning to skip irrelevant streams.
- **Refactored** cover stream scanning to continue after encountering invalid streams.
- **Refactored** duration scanning for more precise results.
- **Refactored** seeking for more precise position accuracy.
- **Refactored** added more defensive code paths.

### Fixed

- **Fixed** unified audio timeline and hardened resampling safety boundaries.

## [0.1.2] - 2026-07-14

- **Added** `Send` implementation for `ChannelLayout`, enabling it to be safely transferred across threads.
- **Added** `Sync` implementation for `ChannelLayout`, enabling shared references across threads.
- **Added** `Send` implementation for `Resampler`, enabling it to be safely transferred across threads.

## [0.1.1] - 2026-07-14

- **Changed** package description from "High-level Rust audio processing, decoding, and resampling engine based on FFmpeg." to "A lightweight FFmpeg audio decoding wrapper designed for music player applications."

## [0.1.0] - 2026-07-14

- Initial release of the high-level audio decoding and resampling crate built on top of `ffmpeg_audio_sys`.

[0.3.1]: https://github.com/apoint123/ffmpeg-audio/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/apoint123/ffmpeg-audio/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apoint123/ffmpeg-audio/releases/tag/v0.1.0
