# EchoMusic Vendor Notes

This directory vendors `soundtouch-rs` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/apoint123/soundtouch-rs
- Vendored commit: `0948861b7019bc41efddb28e9b70d6facf7385e6`
- License: LGPL-2.1, as declared in the upstream README

## Local Usage

EchoMusic uses this vendored tree for playback speed processing in:

```toml
soundtouch-rs = { path = "vendor/soundtouch-rs" }
```

The vendored `ffmpeg-audio` workspace also points its `crates/soundtouch` dependency at this local tree:

```toml
soundtouch-rs = { path = "../../../soundtouch-rs" }
```

## Update Procedure

Use a temporary clone and copy the upstream tree into this directory without the upstream `.git` metadata:

```bash
git clone https://github.com/apoint123/soundtouch-rs /tmp/soundtouch-rs-update
rsync -a --delete --exclude .git \
  /tmp/soundtouch-rs-update/ \
  native/echo-ffmpeg-player/vendor/soundtouch-rs/
```

After syncing, update the `Vendored commit` value above, review local diffs, and run the native player checks.

Do not commit `native/echo-ffmpeg-player/vendor/soundtouch-rs/.git`; the vendor tree should remain regular files in the EchoMusic repository.
