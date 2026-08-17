# EchoMusic Vendor Notes

This directory vendors `soundtouch-rs` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/apoint123/soundtouch-rs
- Vendored commit: `3e1b9014018a66c7d419e051ab8c2b91c8e93e92`
- License: LGPL-2.1, as declared in the upstream README

## EchoMusic Compatibility Patches

- Keep the dev-only `ffmpeg_audio` dependency pointed at the local vendored path instead of upstream Git.
- Keep `default-features = false` on the `ffmpeg-audio/crates/soundtouch` WASM wrapper; it only uses the WSOLA engine.

## EchoMusic Spectral Extension

`src/spectral/`, the `spectral` Cargo feature, and `benches/spectral_bench.rs` are EchoMusic-maintained extensions and are not part of the upstream `apoint123/soundtouch-rs` commit above. The implementation is partially adapted from [Signalsmith Stretch](https://github.com/Signalsmith-Audio/signalsmith-stretch), Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd., under the MIT License. The required notice is preserved in `src/spectral/LICENSE-SIGNALSMITH.md` and in the source-file headers.

Do not remove these files during an upstream refresh. Changes to the spectral implementation must preserve the Signalsmith copyright and MIT notice.

## Local Usage

EchoMusic uses this vendored tree for playback speed processing in:

```toml
soundtouch-rs = { path = "vendor/soundtouch-rs" }
```

The vendored `ffmpeg-audio` workspace also points its `crates/soundtouch` dependency at this local tree:

```toml
soundtouch-rs = { path = "../../../soundtouch-rs", default-features = false }
```

## Update Procedure

Use a temporary clone and copy the upstream tree into this directory without the upstream `.git` metadata:

```bash
git clone https://github.com/apoint123/soundtouch-rs /tmp/soundtouch-rs-update
rsync -a --delete --exclude .git \
  --exclude src/spectral \
  --exclude benches/spectral_bench.rs \
  /tmp/soundtouch-rs-update/ \
  native/echo-ffmpeg-player/vendor/soundtouch-rs/
```

After syncing, update the `Vendored commit` value above; re-apply the Cargo feature, exports, README, lockfile, and compatibility patches listed above; review local diffs; and run the native player checks. In particular, verify that `src/spectral/LICENSE-SIGNALSMITH.md` is still present before committing.

Do not commit `native/echo-ffmpeg-player/vendor/soundtouch-rs/.git`; the vendor tree should remain regular files in the EchoMusic repository.
