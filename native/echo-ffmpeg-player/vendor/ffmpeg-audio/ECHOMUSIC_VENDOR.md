# EchoMusic Vendor Notes

This directory vendors `ffmpeg-audio` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/apoint123/ffmpeg-audio
- Vendored commit: `ab07670314c5b44a174e71f8bd1ce9a4d4ae2f6f`
- License: GPL-3.0-only

## Local Usage

EchoMusic uses `crates/ffmpeg_audio` from this vendored tree in:

```toml
ffmpeg_audio = { path = "vendor/ffmpeg-audio/crates/ffmpeg_audio", features = ["http"] }
```

## Update Procedure

Use a temporary clone and copy the upstream tree into this directory without the upstream `.git` metadata:

```bash
git clone https://github.com/apoint123/ffmpeg-audio /tmp/ffmpeg-audio-update
rsync -a --delete --exclude .git \
  /tmp/ffmpeg-audio-update/ \
  native/echo-ffmpeg-player/vendor/ffmpeg-audio/
```

After syncing, update the `Vendored commit` value above, review local diffs, and run the native player checks.

Do not commit `native/echo-ffmpeg-player/vendor/ffmpeg-audio/.git`; the vendor tree should remain regular files in the EchoMusic repository.
