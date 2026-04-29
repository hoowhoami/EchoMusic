# EchoMusic 架构演进

## 概述

本文档记录 EchoMusic 桌面客户端的关键架构决策和演进历程。

## 技术栈

| 层级     | 技术                       |
| -------- | -------------------------- |
| 框架     | Electron + Vue 3           |
| UI       | Tailwind CSS + Reka UI     |
| 状态管理 | Pinia                      |
| 构建     | Vite + electron-builder    |
| 原生扩展 | Rust NAPI addon（napi-rs） |
| 包管理   | pnpm                       |

## 播放引擎演进

### v1.x — Flutter 原生应用

最初 EchoMusic 基于 Flutter 构建，使用 Dart 生态的音频播放方案。随着功能需求增长（系统级音频控制、多格式支持、桌面歌词等），Flutter 桌面端的生态局限逐渐显现，最终决定迁移到 Electron。

### v2.0.0 — Electron + Web Audio（Howler.js）

v2.0.0 使用 Electron 重写，播放引擎采用 Howler.js 在渲染进程内播放音频。简单直接，但存在明显局限：

- 格式支持受限于 Chromium 内置解码器，无法播放高码率 FLAC 等无损格式
- 音频输出设备切换依赖 Web API，设备列表不完整
- 无法实现独占音频输出

### v2.2.2 — mpv 子进程

引入 mpv 作为外部播放引擎，通过 `child_process.spawn` 启动独立进程，使用 JSON IPC socket 通信。

**架构**：

```
渲染进程 → Electron IPC → 主进程 MpvController → JSON IPC socket → mpv 子进程
```

**改进**：

- 支持几乎所有音频格式（FLAC、APE、DSD 等）
- 独立进程崩溃不影响 Electron
- 支持独占音频设备
- 支持音量均衡（volume-gain 属性）

**不足**：

- JSON IPC socket 序列化/反序列化带来通信延迟
- 需要 spawn/kill/重启等进程管理逻辑
- 音量合成器中显示为独立的 mpv 进程，需要 `--audio-client-name` 伪装
- 打包需要包含完整 mpv 可执行文件（~30MB）
- 淡入淡出在 TypeScript 侧用 setInterval 实现，受 JS 事件循环精度限制
- 系统媒体控制仍依赖静音 `<audio>` 元素 + Chromium MediaSession API，mpv 在独立进程中播放音频不经过渲染进程，需要额外维护一个静音 audio 来激活媒体会话，实现不够优雅且受浏览器策略限制；Windows 上还会因此在音量合成器中多出一个未知应用的音频会话

### v2.2.3 — libmpv 内嵌（当前）

将 mpv 子进程替换为 libmpv 动态库内嵌方案。通过 Rust NAPI addon（`echo-mpv-player`）直接调用 libmpv C API。

**架构**：

```
渲染进程 → Electron IPC → 主进程 MpvController → Rust NAPI addon → libmpv（进程内）
```

**关键设计**：

- **运行时动态加载**：Rust 侧使用 `libloading` crate 在运行时加载 libmpv，编译时不依赖 libmpv，任何平台都能编译 addon
- **事件线程独立**：Rust 侧启动独立线程运行 `mpv_wait_event` 循环，通过 `ThreadsafeFunction` 回调到 JS 主线程
- **淡入淡出 Rust 实现**：fade 在独立线程中用高精度 `thread::sleep` 执行 ease-out-quad 缓动，不受 JS 事件循环影响
- **渲染进程零改动**：IPC handler 的 channel 名和参数格式完全不变，只替换主进程侧实现

**改进**：

- 播放命令从 socket 序列化改为直接函数调用，零延迟
- 音量合成器中天然显示为 EchoMusic（同进程）
- 无需进程管理逻辑
- 打包体积减小约 10MB
- 淡入淡出更精确平滑
- 系统媒体控制从静音 `<audio>` + MediaSession API 改为 Rust 原生 addon（echo-media-controls），直接调用各平台原生 API（Windows SMTC / macOS MPNowPlayingInfoCenter / Linux MPRIS），彻底摆脱 Chromium 媒体会话机制

## 原生扩展

项目使用两个 Rust NAPI addon，统一采用 napi-rs 框架：

### echo-media-controls

系统媒体控制集成，支持三平台：

| 平台    | 后端                                 |
| ------- | ------------------------------------ |
| Windows | SMTC（SystemMediaTransportControls） |
| macOS   | MPNowPlayingInfoCenter               |
| Linux   | MPRIS D-Bus                          |

功能：更新歌曲元数据（标题、歌手、封面）、播放状态、播放进度，接收系统媒体按键事件。

### echo-mpv-player

libmpv 播放引擎封装，核心模块：

| 模块            | 职责                                                          |
| --------------- | ------------------------------------------------------------- |
| `mpv_ffi.rs`    | libmpv C API 的 FFI 声明 + 运行时动态加载                     |
| `player.rs`     | MpvPlayer 核心实现：初始化、命令执行、属性操作、mpv_node 解析 |
| `event_loop.rs` | 独立线程事件轮询，通过 ThreadsafeFunction 回调 JS             |
| `types.rs`      | PlayerState、PlayerEvent 等 NAPI 导出类型                     |
| `lib.rs`        | NAPI 入口，导出 25+ 个函数                                    |

## 主进程模块结构

```
src/main/
├── app.ts              # 应用入口，生命周期管理
├── window.ts           # 窗口创建与管理
├── server.ts           # 内嵌 API 代理服务器
├── cache.ts            # HTTP 缓存
├── tray.ts             # 系统托盘
├── mediaControls.ts    # 原生媒体控制（加载 echo-media-controls addon）
├── desktopLyric.ts     # 桌面歌词窗口管理
├── mpv/
│   ├── controller.ts   # MpvController（加载 echo-mpv-player addon）
│   ├── index.ts        # 初始化 + 事件转发到渲染进程
│   ├── path.ts         # libmpv 动态库路径解析
│   └── types.ts        # 播放器状态/事件类型
└── ipc/
    ├── player.ts       # 播放器 IPC handler
    ├── window.ts       # 窗口控制 IPC handler
    └── settings.ts     # 设置 IPC handler
```

## 渲染进程架构

```
src/renderer/
├── App.vue             # 根组件
├── layouts/            # 布局组件（MainLayout、PlayerBar、Sidebar、TitleBar）
├── views/              # 页面视图
├── components/         # 通用组件
│   ├── app/            # 应用级组件（更新弹窗、认证过期等）
│   ├── music/          # 音乐业务组件（歌曲列表、评论等）
│   ├── player/         # 播放器控件（音量、倍速、音质选择等）
│   └── ui/             # 基础 UI 组件
├── stores/             # Pinia 状态管理
│   ├── player.ts       # 播放器核心状态与逻辑
│   ├── playlist.ts     # 播放列表/队列管理
│   ├── lyric.ts        # 歌词状态
│   ├── setting.ts      # 用户设置
│   └── user.ts         # 用户信息
├── utils/
│   ├── player.ts       # PlayerEngine（封装 mpv preload API）
│   ├── request.ts      # HTTP 请求封装
│   └── ...
├── api/                # API 接口定义
└── electron.d.ts       # Electron preload API 类型声明
```

## CI/CD

GitHub Actions 工作流，支持 5 个平台目标：

| 目标        | Runner           | 产物                              |
| ----------- | ---------------- | --------------------------------- |
| macOS arm64 | macos-latest     | .dmg                              |
| macOS x64   | macos-14         | .dmg                              |
| Linux x64   | ubuntu-22.04     | .AppImage / .deb / .rpm / .tar.gz |
| Linux arm64 | ubuntu-22.04-arm | .AppImage / .deb / .rpm / .tar.gz |
| Windows x64 | windows-latest   | .exe (NSIS)                       |

构建流程：

1. 安装 pnpm + Node.js + Rust 工具链
2. 构建 echo-media-controls addon
3. 构建 echo-mpv-player addon
4. 下载 libmpv 动态库及依赖（macOS: Homebrew, Linux: apt, Windows: zhongfly 预编译）
5. vue-tsc 类型检查 + vite 构建 + electron-builder 打包
6. 上传构建产物 → 创建 GitHub Release → 发送 Telegram/QQ 通知
