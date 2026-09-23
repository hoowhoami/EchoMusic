# EchoMusic 投放竞品与 Rust 实现调研

日期：2026-09-23。范围：发送端；AirPlay 首期 macOS / Windows / Linux。结论基于第一方文档、第一手历史抓包记录及下载源码的静态检查。本轮未构建候选库、未运行竞品、未连接真实设备。本文保留调研阶段建议；随后确认的开发范围以 [最终设计](dlna-airplay-design.md) 为准。

## 1. 竞品究竟传什么

| 对象 | 可确认事实 | 不能由此推出 |
| --- | --- | --- |
| QQ 音乐 QPlay 2.0 | TME Connect 授权认证伙伴 ReaLab 明确称原 QPlay 2.0 为 URL 链接直传；现已并入 TME Connect | 不能把新版 QPlay 全部归为同一路径，也不能证明每项音效开关的当前行为 |
| QQ 音乐新版专用投放 | 杰科与 QQ 音乐合作产品资料列出 TME Connect / QPlay 3.0 和全景声传输 | 厂商对特殊设备/格式的支持，不等于通用 DLNA 保留手机端任意 EQ；本轮未取得足够第一方细节确认全部 PCM 路径 |
| 网易云音乐 DLNA | 2020 年 cloudMusicDlna 作者第一手抓包记录说明通过 HTTP/XML 告知设备媒体 URL | 历史观察不能证明 2026 年所有客户端、桌面版本及音效行为 |
| 两者移动客户端兼容 | 华为官方音箱指南列出 QQ 音乐、网易云 Android / iOS DLNA 支持 | 不能由设备兼容列表推出 DSP 生效、桌面覆盖或特定客户端版本行为 |

资料：

- [ReaLab TME Connect 官方认证服务](https://www.realab.com/1784536479413.html)
- [杰科 2026-04-27 产品说明](https://www.giec.cn/index/Index/newsContent?id=49)
- [cloudMusicDlna 作者的历史抓包说明](https://github.com/zanjie1999/cloudMusicDlna)
- [华为官方 DLNA 音频播放指南](https://consumer.huawei.com/cn/support/content/zh-cn00977484/)

工程推断：当发送的是未经处理的原曲 URL，音箱自行下载和解码，手机/电脑播放器的本地 DSP 不在这条音频链上。URL 本身不代表原曲：本机实时处理流也可以通过 HTTP URL 提供，因此仅看到局域网 URL 不能证明 DSP 生效或未生效。

本轮没有找到足以确认 QQ / 网易云当前各版本在普通 DLNA 或 AirPlay 下保留全部本机音效的可靠证据，不以“支持无损”“支持全景声”代替该证据。对照竞品最有价值的是区分传输模式，而不是推测其内部实现。

## 2. Rust DLNA 候选

| 候选与检查版本 | 已有实现 | 适用判断 |
| --- | --- | --- |
| rupnp 3.0.0，MIT/Apache-2.0 | SSDP 搜索、设备/服务描述、SOAP action、GENA 订阅/续订/退订 | 优先作为薄 UPnP 底层，宿主补 DLNA 媒体服务与会话管理 |
| crab-dlna 0.2.1，commit 2ffe467 | rupnp 2 + warp 文件服务，SetAVTransportURI 后 Play | 适合研究最小闭环，不直接作为完整桌面播放器后端 |
| upnp-client 0.1.11，commit ca1c856 | 高层加载、播放、暂停、seek、音量、格式查询、订阅 | 可参考动作封装；全局广播状态与网络 XML 的 unwrap 需改造 |
| switchy_upnp 0.3.0，MPL-2.0 | 基于 rupnp 的扫描、缓存、控制、事件订阅 | 能力较多，但带 MoosicBox 生态依赖；本项目优先较薄方案 |

### rupnp 不是整个 DLNA 播放器

检查源码包 VCS commit `00ec066e75f95a0874aaef238baebb643b354f83`。`src/service.rs` 已有订阅能力，不能误称事件订阅需要全部从零实现。但其通知读取按行匹配固定 XML 前缀，HTTP 通知解析、大小/超时限制、SID/SEQ 检查与按目标路由选择本机回调地址需要加强；`utils.rs` 的 HTTP body collect 也需要资源限制。

EchoMusic 仍须负责：多网卡与发现过期、设备能力协商、媒体 URL 有效期、鉴权源中转、GET/HEAD/Range、流式背压、队列和播放时间校正、切歌取消、事件续订与断连回收。不能把 generic action API 当成已完成兼容性。

crab-dlna 主要是提供文件 URL，再设置远端播放地址；代码没有本机 DSP/转码链。底层 warp 文件服务的具体 HTTP 能力应单独验证，不能因调用短就断言 Range 不支持。

源码入口：

- [rupnp 3.0.0 文档](https://docs.rs/rupnp/3.0.0/rupnp/)；[service.rs 固定版本](https://github.com/jakobhellermann/rupnp/blob/00ec066e75f95a0874aaef238baebb643b354f83/src/service.rs)
- [crab-dlna 固定版本](https://github.com/gabrielmagno/crab-dlna/tree/2ffe46757a8b19313a976c86d7ed38d2062c5ff7)
- [upnp-client 固定版本](https://github.com/tsirysndr/upnp-client-rs/tree/ca1c856330ba6f0ea2ae03fb24e5111deef4422c)
- [switchy_upnp 0.3.0 源码](https://docs.rs/crate/switchy_upnp/0.3.0/source/)

## 3. Rust AirPlay 发送候选

### airplay2-rs：可以做验证起点，尚不能直接承诺产品可用

检查 commit `a2f980cf25bf13ae20158497cc2d2ea69cd88fa7`，2026-09-13；workspace 0.1.0，GPL-3.0-or-later，README 标为 alpha。已有发现、配对、会话与发送音频代码。

实际发现：

1. `airplay-client/src/client.rs` 的 `play_pcm()` 返回未实现错误。但 `start_live_streaming()` 确实创建 LiveAudioDecoder 并返回 PCM sender，可作为接入现有 EchoMusic 音频链的起点。
2. 同文件高层 `seek()` 仅发 PositionUpdated 事件，然后返回成功。源码明确写着尚未清缓冲、移动解码器、重新填充和恢复。不能直接连接 UI 拖动条。
3. `airplay-audio/src/live_decoder.rs` 的输入是 `Vec<i16>`。不能凭 ALAC 编码宣称 24-bit 源逐样本保留；需要明确协商和显示实际传输格式。
4. `try_send()` 遇队列满会丢帧。音乐播放应在非实时生产线程做有界背压与取消，不能照抄实时捕获丢帧策略，也不能阻塞音频实时回调。
5. `airplay-audio/src/rtp.rs` 的 `set_socket_qos()` 无条件导入 Unix `AsRawFd`。从静态源码可见当前 Windows 适配阻碍，本轮未通过编译确认其余平台缺口。
6. 该库自带解码、EQ 等模块。EchoMusic 应接入自身解码/DSP 的 PCM 输出，避免重复解码或两套音效处理。暂停、seek、切歌还要同时协调本地生产、远端旧缓冲和播放时间。

固定源码：

- [client.rs](https://github.com/lmcgartland/airplay2-rs/blob/a2f980cf25bf13ae20158497cc2d2ea69cd88fa7/crates/airplay-client/src/client.rs)
- [live_decoder.rs](https://github.com/lmcgartland/airplay2-rs/blob/a2f980cf25bf13ae20158497cc2d2ea69cd88fa7/crates/airplay-audio/src/live_decoder.rs)
- [rtp.rs](https://github.com/lmcgartland/airplay2-rs/blob/a2f980cf25bf13ae20158497cc2d2ea69cd88fa7/crates/airplay-audio/src/rtp.rs)

### AirSend：Windows 补丁参考

检查 commit `d309942c83248de60e7133b69bf2bb552dff511f`，2026-09-21。这是 Windows/Tauri 发送应用，标为 pre-alpha，不是独立成熟 SDK。它固定使用 airplay2-rs 的补丁 fork（rev `655b2768e2a17aa64f84d0b5b36325018963e909`）；Cargo 文件直接注明 Unix socket 隔离与 Windows MMCSS 修补原因。

其当前发送配置为 ALAC / 44.1 kHz / 16-bit / 双声道，不能推广为所有 AirPlay 的格式上限。配置中的缓冲 profile 也不是本轮端到端延迟测量。它可用于借鉴 Windows 修补与会话实践，不需要将其系统声音捕获方案引入 EchoMusic。

- [AirSend 固定版本](https://github.com/Pabldi08/AirSend/tree/d309942c83248de60e7133b69bf2bb552dff511f)
- [fork 依赖与 Windows 修补说明](https://github.com/Pabldi08/AirSend/blob/d309942c83248de60e7133b69bf2bb552dff511f/crates/airplay-core/Cargo.toml)

其他名称容易混淆：[openairplay2](https://docs.rs/openairplay2/latest/openairplay2/) 和 [shairplay](https://docs.rs/shairplay/latest/shairplay/) 是接收方向，不能作为本任务的发送 SDK；mdns-sd 只解决发现。

当前 EchoMusic package.json 标记 GPL-3.0-only。上述许可证字段作为选型记录保留，不在本次静态调研中作完整依赖与发行合规结论。

## 4. 调研阶段建议（历史记录，以最终设计为准）

### 首期产品边界

- DLNA 默认原曲投放，必要时由宿主原样中转。原曲路径明确显示“由设备播放，本机音效不生效”，保留用户已有音效设置；设备音量独立于本机软件增益。
- AirPlay 以 EchoMusic 本机解码 → 现有 DSP → PCM → 编码/发送为目标，保留本机音效。传输编码无损与源格式完全保留是两件事。
- DLNA 处理后实时流作为后续可选路径预留。先验证设备是否接受所选流格式、是否可稳定暂停/seek，再决定是否进入首期；不因 URL 方式存在就认定协议禁止 DSP。
- 首期三平台、单目标；不做接收与多房间同步。AirPlay 三平台是既定目标，库缺口意味着需要修补和实测，而不是悄悄改成 macOS 独有。
- 暂不新增公开输出 provider 插件 API。设备发现、网络服务、凭证、会话与音频实时线程由宿主持有；既有音源插件继续供给资源，播放控制作用于当前输出。歌词皮肤若需设备入口，按实际需求加最小消费接口。

### 实施前最小技术验证

1. rupnp 发现 + 格式查询 + 一首本地文件远端播放，随后验证暂停、音量、seek、EOF 和设备离线；至少音箱和电视/接收器两类。
2. 锁定 airplay2-rs commit，吸收必要 Windows 补丁，验证 macOS/Windows/Linux 原生构建和同一目标设备播放。先输入已知 PCM，随后接入 EchoMusic 音频链。
3. 补实高层 seek/flush，验证快速切歌无旧音残留、停止不被 EOF 误推进、断线取消、睡眠恢复、配对持久化及资源清理。
4. 对同一测试音源分别开启/关闭显著 EQ，验证 AirPlay 接收声音确实改变；记录传输格式与开始、暂停、seek、音效调整的可听延迟。与“音效开关 UI 变化”区分。
5. 如进一步实测竞品，记录客户端版本/平台/设备固件/所选协议，检查 SetAVTransportURI 及实际媒体内容；关闭应用后继续播放只作线索，不能单独证明音频路径。当前竞品资料不足以替代此项。

验收必须分别报告：静态源码、跨平台编译、模拟会话测试和真机结果。本轮只完成前一项及资料调研。
