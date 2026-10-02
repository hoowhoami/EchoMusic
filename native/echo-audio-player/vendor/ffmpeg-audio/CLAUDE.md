# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

面向音乐播放器的 FFmpeg 音频解码封装：静态编译一份裁剪过的 FFmpeg（无需 C 构建系统），在其上提供安全的 Rust 解码/重采样 API，并附带一个基于 Emscripten 的 Web 播放器 demo。其中的 `audio-core` 设计为在其他项目中复用。

## 命令

需要 **nightly** Rust（CI 用 nightly + `rust-src`）：`.cargo/config.toml` 启用了 `build-std` 等 unstable 选项，`rustfmt.toml` 也用了 unstable 选项。首次构建会用 `cc` 编译整份 FFmpeg C 源码，较慢。

```bash
cargo test -p ffmpeg_audio                                   # CI 在各主机目标上运行的测试
cargo test -p ffmpeg_audio --test integration_test test_seek_accuracy   # 单个集成测试
cargo test -p ffmpeg_audio --lib cursor                      # 按名称过滤模块内单元测试
cargo clippy --workspace -- -D warnings
cargo fmt --all -- --check
cargo test --target wasm32-unknown-emscripten -p ffmpeg_audio   # 需 emsdk；Node runner 已在 .cargo/config.toml 配好
cargo run --example play -- path/to/audio.mp3                # 另有 metadata 示例
pnpm lint && pnpm format:check && pnpm typecheck             # TS 检查（仓库根目录，biome + tsc）
```

- HTTP 测试需要 `http` feature，且被 `#[ignore]`：先在 `crates/ffmpeg_audio/tests/` 下运行 `go run server.go`（它按相对路径读取 `assets/`），再运行 `cargo test -p ffmpeg_audio --features http --test http_test -- --ignored`。
- Web demo：在 `web/` 下运行 `pnpm wasm`（需 emsdk 与 `wasm-pack`；构建 `ffmpeg_wasm` 与 `soundtouch`，并把产物复制进 `web/src/audio-core/{worker,worklet}/wasm/`，这些产物已被 gitignore），然后运行 `pnpm dev`。
- 文件类测试（`integration_test.rs` 的 `file_tests` 模块）在 wasm32 上被 cfg 掉；`tests/assets/` 下每个素材各对应一种边界情况（AAC seek、流中途格式变化、负 PTS 的 Matroska）。
- CI 的 target 矩阵定义在 `scripts/ci/platforms.ts`：PR 与发版前跑完整矩阵，`main` 上的普通提交只跑 `PUSH_PLATFORMS` 里的代表性子集。因此改动下列任一项后，必须手动跑一次完整矩阵（`gh workflow run ci.yml`，`full` 默认即 true）并等它通过，再提交或合并——常驻子集覆盖不到其余平台：`crates/ffmpeg_audio_sys/**`（`get_config_dir_name()`、`src/consts.rs`、`vendor/`）、`scripts/generate_config.ts`、`scripts/extract_slim.ts`、`.github/workflows/update-ffmpeg.yml`、`.cargo/config.toml` 与工作区 `Cargo.toml` 的 profile、以及任何 `#[cfg(target_os / target_arch / target_env / target_abi)]` 分支。

## 架构

依赖方向：`ffmpeg_audio_sys` ← `ffmpeg_audio` ← `ffmpeg_wasm` → `web/`；`soundtouch` 独立，只供 `web/` 的 AudioWorklet 使用。

### ffmpeg_audio_sys：内置 FFmpeg 的构建

- `vendor/ffmpeg_slim.zip` 与 `vendor/configs.zip` 是生成产物，由 GitHub 上手动触发的 **Update Bundled FFmpeg** workflow 生成：`scripts/generate_config.ts` 在各平台运行 FFmpeg `configure` 与 `make V=1 -n`，得到 `config.h` 和 `make_dryrun.log`；`scripts/extract_slim.ts` 只挑出所需源码并打包。修改启用的 demuxer/decoder 时，改 `generate_config.ts` 里的列表，再重跑该 workflow；两个 zip 始终由 workflow 重新生成。
- `build.rs` 通过 `get_config_dir_name()` 按目标选择配置目录，解析 `make_dryrun.log` 得到 C 文件、宏定义和 include 路径，用 `cc` 编译，再用 bindgen 生成绑定（按 `av_*`、`avformat_*` 等前缀白名单）。本地实验时，解压后的 `vendor/ffmpeg_slim/` + `vendor/configs/`（已 gitignore）优先于 zip。
- 环境变量：`FFMPEG_MODE=bundled|system`、`FFMPEG_CUSTOM_CONFIG`（详见 `crates/ffmpeg_audio_sys/README.md`）。新增目标平台需同时改 `get_config_dir_name()` 与 workflow 矩阵。
- `src/consts.rs` 手写了 bindgen 无法翻译的 FFmpeg 宏（`AVERROR_*` 等）。

### ffmpeg_audio：解码管线

`Read + Seek` 源 → `decode/io.rs` 的 `IoContext`（AVIOContext 回调）→ `Demuxer`（选最佳音频流并丢弃其余流；元数据、封面）→ `Decoder` → `DecodeEngine`（编排 send/receive 状态机）→ `AudioFrame`（零拷贝，借用解码器当前帧）→ `Resampler`（封装 SwrContext；帧的格式、采样率或声道布局中途变化时自动重建）。`lib.rs` 是公共门面：`AudioReader` 交付原始帧，`ResampledReader` 交付类型化样本。

时间相关代码先读 `CONTEXT.md`（领域术语：公共时间轴、零点、Preroll、精确/快速定位、声明/精确时长）和 `docs/adr/`。核心不变量：

- `core/timeline.rs` 的 `Timeline` 是原始时间戳与公共时间轴互相换算的唯一入口：精确有理数运算，只舍入一次——样本位置向上取整，对外报告的时间向下取整到纳秒，因此 seek 到报告过的时间戳会落在同一个样本上。Preroll 裁剪与精确定位裁剪都产出 `FramePlacement`（`offset` + `samples`），帧数据本身不复制，由 `AudioFrame::raw_data` 与 `Resampler` 按 `offset` 读取。
- `decode/cursor.rs` 的 `ReadCursor` 状态机记录每次 seek、交付与耗尽；`scan_exact_duration` 先保存游标，扫描后按 `Resume` 恢复，使扫描对后续读取透明（相同的帧、相同的 `stream_position`）。新增任何会移动 demuxer 或交付帧的路径，都要同步记录到游标。
- 精确定位的契约，以及容器存在不可达位置时的取舍，见 `docs/adr/0001-*.md`。

Feature：`http` 提供 `core/http.rs`（基于 HTTP Range 请求的阻塞式 `Read + Seek`，内部自带 tokio runtime，含重试/重连，通过 `HttpCancelHandle` 取消）；`tracing` 把 FFmpeg 的 `av_log` 转发到 tracing（`log.rs`）。

### ffmpeg_wasm、soundtouch 与 web/

- `ffmpeg_wasm` 是 Emscripten 可执行文件，在 `ResampledReader`（planar f32）之上暴露 C ABI 函数 `wasm_decoder_*`。文件字节经 `js_read_file`/`js_get_file_size` 从 JS 读取（`library_ffmpeg.js` → worker 中的回调）。新增或重命名导出函数时，同步修改 `crates/ffmpeg_wasm/build.rs` 的导出列表和 `web/src/audio-core/worker/types/wasm.ts`。
- `soundtouch` 是 wasm-bindgen cdylib（wasm-pack 构建，目标 `wasm32-unknown-unknown`；`ffmpeg_audio` 本身不支持该目标），在 AudioWorklet 中做变速/变调。
- `web/` 数据流：主线程 `FFmpegAudioEngine`（`engine.ts`）→ 解码 Web Worker 运行 `ffmpeg_wasm`，把 PCM 写入 SharedArrayBuffer 环形队列（`queue/index.ts`，控制块用 Atomics 读写）→ AudioWorklet 读取队列并经 SoundTouch 输出。SharedArrayBuffer 需要 COOP/COEP 响应头（已在 `vite.config.ts` 设置）。

## 约定

- Rust 代码注释与 rustdoc 用英文；领域文档（`CONTEXT.md`、`docs/adr/`）用中文。命名与文档使用 `CONTEXT.md` 中的术语，避开各条目 `_Avoid_` 后列出的说法。
- 各 crate 启用了 clippy `pedantic` + `nursery`，CI 以 `-D warnings` 运行，这类警告同样会让 CI 失败。
- 提交信息：Conventional Commits，中文描述；`ffmpeg_audio` 的改动用 scope `core`，破坏性变更加 `!`（如 `refactor(core)!: ...`）。
- 用户可见的改动用 `pnpm changeset` 新增一个碎片（`.changeset/*.md`），不要直接改 `CHANGELOG.md`：一个碎片写一条英文记录，以加粗动词开头；0.x 阶段破坏性变更写 `minor`、其余写 `patch`，不写 `major`；sys 有破坏性变更时同一碎片里给 `ffmpeg_audio` 也写 `minor`。详见 `.changeset/README.md`。发版由 CI 完成（合并 release PR 即发版，见 `docs/adr/0002-*.md`），不要手动改版本号或打 tag。
- TS 由 biome 格式化（tab 缩进、双引号），`pnpm lint` 带 `--error-on-warnings`。
