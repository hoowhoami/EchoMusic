# Vendored 依赖与可复现构建

本目录存放为 DLNA / AirPlay 发送功能锁定的上游依赖（拷贝进仓库以便应用必需补丁，保证可复现构建，不依赖临时目录 `/private/tmp/echo-cast-research`）。

规则：只允许在仓库内修改这些拷贝；任何改动以追加补丁文件方式记录并说明原因；构建必须走本目录，不引用外部路径。

## rupnp 3.0.0 — `native/echo-upnp/vendor/rupnp`

- 来源：crates.io `rupnp`，版本 3.0.0（research 转载源码 commit `00ec066e75f95a0874aaef238baebb643b354f83`）。
- 许可：MIT / Apache-2.0。
- 用途：DLNA 薄 UPnP 底层（设备描述、SOAP action、GENA subscribe/renew/unsubscribe）。
- EchoMusic 补丁：
  1. `utils.rs` body collect 增加大小上限，`service.rs` 通知解析加固（限制大小/层级、SID/SEQ 检查、超时）——调研 §2 指出的必须加固点。

## airplay2-rs — `native/echo-upnp/vendor/airplay2-rs`

- 来源：`https://github.com/lmcgartland/airplay2-rs`，commit `a2f980cf25bf13ae20158497cc2d2ea69cd88fa7`（2026-09-13）。
- 许可：GPL-3.0-or-later；宿主项目 GPL-3.0-only，按 `or-later` 允许以 GPL-3.0-only 合并使用。
- 用途：独立 AirPlay 发送（发现、配对、RTSP/RTP 会话、实时 PCM 编码）。
- EchoMusic 补丁（对应 research §3 / AirSend `rev 655b276` Windows 修补参考）：
  1. `airplay-audio/src/rtp.rs`：`set_socket_qos` 的 `AsRawFd` 导入加 `cfg(unix)` 隔离，Windows（MSVC）可编译。
  2. `airplay-audio/src/live_decoder.rs`：新增有界背压的阻塞发送（含超时与取消），不再用 `try_send` 丢帧；新增 seek/epoch 机制 —— 解码侧发现 epoch 变化时清空待发帧、复位 `position_samples` 与残留缓冲，使快速切歌/seek 后远端无旧音频残留。
  3. `airplay-client/src/client.rs`：高层 `seek()` 实现真实路径 —— 触发 `connection.send_flush` 清远端缓冲 + 同步 decoder 位置复位，不再只发 `PositionUpdated` 假成功。
