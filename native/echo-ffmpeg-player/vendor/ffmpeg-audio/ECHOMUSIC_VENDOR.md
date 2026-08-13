# EchoMusic Vendor Notes

This directory vendors `ffmpeg-audio` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/apoint123/ffmpeg-audio
- Vendored commit: `d997800046723f22f823ddbcf45ea2e00601ef66`
- License: GPL-3.0-only

## EchoMusic Compatibility Patches

- Keep EchoMusic's packet-cache/multi-audio-stream/raw-frame API surface used by the native player.
- Keep `HttpAudioSourceOptions` for player network timeout and HTTP proxy settings.
- Bridge EchoMusic's `Arc<AtomicBool>` decode interrupt flag to upstream's `HttpCancelHandle`.
- Keep `crates/soundtouch` pointed at the local vendored `soundtouch-rs` path.
- Pin `futures-util` to `0.3.32` to stay compatible with the current native player lockfile.

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

After syncing, update the `Vendored commit` value above, re-apply the compatibility patches listed above, review local diffs, and run the native player checks.

Do not commit `native/echo-ffmpeg-player/vendor/ffmpeg-audio/.git`; the vendor tree should remain regular files in the EchoMusic repository.
