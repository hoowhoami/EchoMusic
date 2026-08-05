# EchoMusic Vendor Notes

## Source

- Upstream crate: `pipewire`
- Vendored version: `0.10.0`
- License: MIT, matching the upstream crate

## Why This Is Vendored

`cpal 0.18.1` enables PipeWire through `pipewire 0.10.0` with the
`v0_3_53` feature. On Linux CI, `pipewire-sys 0.10.0` generates bindings from
system PipeWire headers that do not expose several APIs assumed by the Rust
`pipewire` crate:

- `PW_KEY_DEVICE_SYSFS_PATH`
- `pw_stream_get_time_n`
- `pw_buffer.requested`
- `pw_time.buffered`
- `pw_time.queued_buffers`
- `pw_time.avail_buffers`

The result is a compile-time mismatch between crate feature flags and the
actual system headers.

## Local Changes

- `src/keys.rs`: define `DEVICE_SYSFS_PATH` from the stable key string
  `"device.sysfs.path"` instead of requiring a generated sys constant.
- `src/buffer.rs`: make `Buffer::requested()` fall back to the mapped SPA data
  capacity. `cpal` caps this value by the same mapped capacity after dividing by
  stride, so older PipeWire headers fill the current buffer instead of producing
  zero frames.
- `src/stream/mod.rs`: use `pw_stream_get_time()` instead of
  `pw_stream_get_time_n()`. The fields used by `cpal` (`now`, `rate`, `ticks`,
  `delay`) are still populated by the older API.
- `src/stream/mod.rs`: expose `buffered()`, `queued_buffers()`, and
  `avail_buffers()` as zero-valued compatibility accessors when those generated
  fields are unavailable.

## Removal

When upstream `pipewire` publishes a release whose Rust feature gates are
compatible with older distro headers, or CI moves to headers that provide these
symbols, remove the `[patch.crates-io]` entry from
`native/echo-ffmpeg-player/Cargo.toml`, delete this vendor directory, run
`cargo update -p pipewire`, and verify Linux CI with PipeWire enabled.
