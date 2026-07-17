# Third-Party Notices

EchoMusic is distributed under the GNU General Public License v3.0. See [LICENSE](LICENSE).

This file summarizes important third-party components used by EchoMusic, especially components that are bundled with the application or affect redistribution terms. It is not a full dependency lockfile. For complete dependency trees, see [pnpm-lock.yaml](pnpm-lock.yaml) and the Cargo lockfiles under `native/`.

## Bundled And License-Relevant Components

| Component         | Use                                                            | License                                                              | Source / Notice                                                                                                  |
| ----------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ffmpeg-audio`    | FFmpeg-based audio decoding in `echo-ffmpeg-player`            | GPL-3.0-only                                                         | Vendored at `native/echo-ffmpeg-player/vendor/ffmpeg-audio`; upstream: https://github.com/apoint123/ffmpeg-audio |
| FFmpeg            | Audio demuxing, decoding and resampling through `ffmpeg-audio` | LGPL-2.1-or-later / GPL-2.0-or-later depending on enabled components | https://ffmpeg.org/                                                                                              |
| Electron          | Desktop runtime                                                | MIT                                                                  | https://www.electronjs.org/                                                                                      |
| Vue               | Renderer UI framework                                          | MIT                                                                  | https://vuejs.org/                                                                                               |
| Vite              | Build tooling                                                  | MIT                                                                  | https://vite.dev/                                                                                                |
| napi-rs           | Native Node addon framework                                    | MIT                                                                  | https://napi.rs/                                                                                                 |
| cpal              | Native audio output abstraction                                | Apache-2.0 OR MIT                                                    | https://github.com/RustAudio/cpal                                                                                |
| rusqlite / SQLite | Local persistent storage                                       | MIT for `rusqlite`; SQLite is public domain                          | https://github.com/rusqlite/rusqlite / https://sqlite.org/                                                       |

## Native Modules

- `native/echo-ffmpeg-player` embeds the playback engine and depends on vendored `ffmpeg-audio`.
- `native/echo-media-controls` integrates platform media controls.
- `native/echo-storage` provides local SQLite-backed storage.

## GPLv3 Distribution Note

Because EchoMusic links and distributes GPL-licensed playback components, EchoMusic distribution builds are provided under GPLv3-compatible terms, with the project license set to GNU GPL v3.0.

When redistributing EchoMusic binaries, provide the corresponding source code, this notice file, and the full GPLv3 license text.
