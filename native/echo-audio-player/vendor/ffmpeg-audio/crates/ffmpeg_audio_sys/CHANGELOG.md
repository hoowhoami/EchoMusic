# ffmpeg_audio_sys

## 0.2.0

### Minor Changes

- [#13](https://github.com/apoint123/ffmpeg-audio/pull/13) [`0dff143`](https://github.com/apoint123/ffmpeg-audio/commit/0dff143bfd9b9b8b11436882970559d930a49ef0) Thanks [@apoint123](https://github.com/apoint123)! - **Updated** bundled FFmpeg from 8.1.2 to 9.0.2 (libavcodec 63, libavformat 63, libavutil 61, libswresample 7). APIs removed upstream in this major release (e.g. `AVCodecContext.properties`, the private fields of `AVCodecParser`, `AVTimebaseSource`) are no longer available in the generated bindings.

### Patch Changes

- [`f31bdec`](https://github.com/apoint123/ffmpeg-audio/commit/f31bdec485f83121e907b0beb686fa6222041f61) Thanks [@apoint123](https://github.com/apoint123)! - **Fixed** the build script reusing FFmpeg sources extracted from a previous version of the bundled archives, so incremental builds could silently keep compiling the old FFmpeg after the archives were updated.

## [0.1.2] - 2026-07-14

- No functional changes in this release (version bump only).

## [0.1.1] - 2026-07-14

- **Changed** package description from "Raw FFI bindings for FFmpeg audio processing." to "Raw FFmpeg FFI bindings for ffmpeg_audio."

## [0.1.0] - 2026-07-14

- Initial release of raw FFmpeg FFI bindings.

[0.1.2]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/apoint123/ffmpeg-audio/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/apoint123/ffmpeg-audio/releases/tag/v0.1.0
