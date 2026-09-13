# Gapless FLAC Fixture

`gapless-silence.flac` is a generated 16-second stereo 44.1 kHz / 16-bit signal:
1 second of silence, 13.5 seconds of a 660 Hz sine wave, and 1.5 seconds of silence.
It contains no third-party audio. Tests serve it over chunked HTTP Range responses
and exercise analysis, head trimming, hand-off, and decoding through EOF.

Regenerate with:

```sh
ffmpeg -f lavfi -i 'sine=frequency=660:sample_rate=44100:duration=13.5' \
  -af 'adelay=1000:all=1,apad=pad_dur=1.5' -ac 2 -sample_fmt s16 \
  -c:a flac -map_metadata -1 gapless-silence.flac
```
