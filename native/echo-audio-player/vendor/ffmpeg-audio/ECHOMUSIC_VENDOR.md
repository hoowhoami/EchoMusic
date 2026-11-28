# EchoMusic Vendor Notes

This directory vendors `ffmpeg-audio` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/apoint123/ffmpeg-audio
- Vendored commit: `16bd156c0b9b65cc25cc4fac0f60f54c6260ea08`
- Crate versions: `ffmpeg_audio 0.4.0`, `ffmpeg_audio_sys 0.2.0`
- Bundled FFmpeg: `9.0.2`
- License: GPL-3.0-only

## EchoMusic Compatibility Patches

- Keep EchoMusic's packet-cache/multi-audio-stream/raw-frame API surface used by the native player.
- Keep `HttpAudioSourceOptions` for player network timeout and HTTP proxy settings.
- Accept an optional per-reader `user_agent` in `HttpAudioSourceOptions`. Configure
  the immutable reqwest client default header so initial probes, range seeks and
  reconnects all use the same caller-supplied value. The host owns persistence
  and explicit regeneration; the vendor never changes it automatically. An explicit
  empty string omits the header; None retains the library default for other callers.
- Bridge EchoMusic's `Arc<AtomicBool>` decode interrupt flag to upstream's `HttpCancelHandle`.
- Keep packet-cache pause-wait support, seek timeout, interrupt lifetime, and retained-range recovery.
- Use upstream `Timeline` for cache timestamps and seeks; restore scan cursors with raw ticks through the cache worker. Capture pending frames before scans and restore their exact trim so cached and physical seeks keep their frame boundaries.
- Keep public raw-frame format/channel/sample-rate accessors, borrow-scoped raw slices, and the exported `SwrContext` used by the native audio graph.
- Keep unsigned sample support and the resampler's input-capacity/offset safety checks.
- Keep `reqwest` SOCKS proxy support.
- Disable bindgen's optional `prettyplease` feature to avoid the currently resolved syn 2/3 AST mismatch. Runtime libclang loading and logging remain enabled.
- Allow upstream `scripts/release` in the vendor ignore rules so the host's release-artifact rule does not hide source files.
- Keep `crates/soundtouch` pointed at the local vendored `soundtouch-rs` path.
- Keep the `futures-util` constraint at `0.3.32` to stay compatible with the current native player lockfile.

- HLS custom resource IO uses a caller-owned opener/session, effective-URL AVOptions,
  cancellation and read deadlines. The pinned FFmpeg HLS patch publishes timeline
  facts and permits HTTP(S) with custom IO while FFmpeg networking stays disabled.
  `scripts/enable_hls_bundle.py` deterministically adds the configure-verified HLS
  source/component delta to all existing configurations without changing platform
  flags. The upstream bundle workflow applies `scripts/hls-custom-io.patch` too.

## Local Usage

EchoMusic uses `crates/ffmpeg_audio` from this vendored tree in:

```toml
ffmpeg_audio = { path = "vendor/ffmpeg-audio/crates/ffmpeg_audio", features = ["http"] }
```

## Update Procedure

Use a temporary clone and copy the upstream tree into this directory without the upstream `.git` metadata:

```bash
git clone https://github.com/apoint123/ffmpeg-audio /tmp/ffmpeg-audio-update
rsync -a --exclude .git --exclude target --exclude node_modules \
  /tmp/ffmpeg-audio-update/ \
  native/echo-audio-player/vendor/ffmpeg-audio/
```

Use the recorded commit as the three-way merge base before copying; resolve EchoMusic patches against the new upstream API rather than overwriting the local tree. Preserve ignored local build artifacts and remove only tracked files deleted upstream.

After syncing, update the `Vendored commit` value above, re-apply the compatibility patches listed above, review local diffs, and run the native player checks.

Do not commit `native/echo-audio-player/vendor/ffmpeg-audio/.git`; the vendor tree should remain regular files in the EchoMusic repository.

## Local Validation

Run these from the EchoMusic repository root:

```bash
cargo check --manifest-path native/echo-audio-player/Cargo.toml --locked
cargo test --manifest-path native/echo-audio-player/Cargo.toml --lib --locked -- --test-threads=1
cargo test --manifest-path native/echo-audio-player/vendor/ffmpeg-audio/Cargo.toml -p ffmpeg_audio --features http --lib --test integration_test --test http_test
pnpm --dir native/echo-audio-player build:debug
```

The native player's global runtime tests require serial execution. HTTP tests bind loopback listeners and need a runner that permits local sockets. The three upstream tests requiring `tests/server.go` remain opt-in. Build/load checks do not replace Electron playback or Windows/Linux runtime validation.

## 2026-11-02 macOS common-symbol alignment

`ffmpeg_audio_sys/build.rs` passes `-fno-common` only when compiling the bundled
FFmpeg C sources for macOS. The tentative `ff_table_4_3_exp` byte array (0x803c
bytes) otherwise becomes a Mach-O common symbol with size-derived alignment,
causing Apple's linker to reduce `__DATA,__common` alignment from 0x8000 to
0x4000. BSS definitions retain the C type's actual alignment; explicitly aligned
SIMD data and other platforms keep their existing requirements.
