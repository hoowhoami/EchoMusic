# Synthetic HLS audio fixtures

These fixtures contain generated sine waves, not recorded or third-party music.
Generated with FFmpeg 9.1 (AAC, mono, 44.1 kHz, 32 kbit/s):

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=44100:duration=12' \
  -c:a aac -b:a 32k -f hls -hls_time 1 -hls_list_size 0 \
  -hls_segment_filename s%d.ts vod.m3u8
ffmpeg -f lavfi -i 'sine=frequency=660:sample_rate=44100:duration=6' \
  -c:a aac -b:a 32k -f hls -hls_time 1 -hls_list_size 0 \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 \
  -hls_segment_filename f%d.m4s fmp4.m3u8
```

The local Rust HTTP fixture serves rolling windows of the TS files and preserves
relative resource names behind a redirect. Tests decode PCM without opening an
output device. The checked-in fixtures do not require FFmpeg at test runtime.

`direct.mp3` and `direct.aac` contain two seconds of an 880 Hz sine wave at the
same rate/bitrate. `range.mp4`/`range.m3u8` use six seconds at 550 Hz, fMP4 and
`-hls_flags single_file`, exercising Range requests for both init and media.
The test also synthesizes a master manifest pointing to a relative media URL.
