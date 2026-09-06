# echo-audio-capture

跨平台的系统输出与输入设备音频采集 N-API 模块。它只负责采集、短期缓冲和 PCM 转换，不依赖听歌识曲接口，也不读取 EchoMusic 播放器内部音频。

## 后端

- Windows：WASAPI loopback（通过 CPAL 打开默认输出设备）
- macOS：ScreenCaptureKit 系统音频流
- Linux：PulseAudio/PipeWire monitor source，CPAL 不可用时回退到 `parec`/`pacat`
- 麦克风/输入设备：三平台统一使用 CPAL input stream

## API

- `listInputDevices()`：枚举麦克风/输入设备及其稳定 ID、默认格式。
- `startCapture({ source, deviceId?, maxBufferDurationMs? })`：从 `system` 或 `input` 启动采集；再次启动时会先关闭原会话。
- `snapshotCapture({ durationMs?, sampleRate?, channels?, sampleFormat? })`：不中断采集地读取最近一段 PCM。
- `stopCapture(options?)`：停止并返回 PCM。
- `cancelCapture()`：停止并丢弃缓冲。
- `getCaptureStatus()`：读取源格式、已捕获帧数和运行错误。

缓冲区内部保留采集源的采样率和声道，格式为交错 `f32`。读取时默认保留源采样率和声道，并输出 `f32le`；调用方也可请求 `f32le` 或 `s16le`、指定采样率以及 1～8 个声道。

听歌识曲只是该模块的一个适配器：主进程在停止采集时请求最近 10 秒的 8 kHz、单声道、`s16le` PCM。频谱或其他分析功能可以改用 `snapshotCapture`，无需修改采集后端。

macOS 构建目标与其他 Native 模块一致设为 10.15；ScreenCaptureKit 采用弱链接，并在运行时要求 macOS 12.3 或更高版本，因此不会仅因加载 addon 而额外抬高整个 App 的最低系统版本。
