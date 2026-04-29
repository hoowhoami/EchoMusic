# EchoMusic 原生系统媒体控制设计文档

## 1. 背景与问题

EchoMusic 使用 mpv 子进程作为音频播放引擎，当前的系统媒体集成存在以下问题：

### 1.1 Windows 音量合成器双条目

mpv 是独立子进程，Windows 按进程管理音频会话，导致音量合成器中出现两个条目：

- **EchoMusic**（Electron 渲染进程的静音 `<audio>` 元素）— 静音它无效，因为没有实际音频输出
- **mpv**（实际音频输出）— 用户必须找到这个才能控制音量

### 1.2 Windows 媒体中心出现"未知应用"

mpv 在 Windows 上会自动注册 SMTC（System Media Transport Controls），但没有设置元数据，显示为"未知应用"。同时 Electron 渲染进程通过 Chromium MediaSession API 也注册了一个，导致出现两个媒体条目。

### 1.3 核心矛盾

Chromium 的 `navigator.mediaSession` API 需要活跃的 `<audio>` 元素才能工作，但实际音频输出在 mpv 子进程。为了激活 MediaSession，渲染进程维护了一个极低音量的静音 `<audio>` 元素，这又导致了音量合成器的双条目问题。

## 2. 解决方案概述

**在 Electron 主进程中通过 Rust native addon 直接操作各平台的系统媒体 API**，完全绕过 Chromium MediaSession 和 mpv 的自动 SMTC/MPRIS 注册。

### 2.1 目标架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        渲染进程 (Renderer)                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ PlayerBar.vue│───▶│ player store     │───▶│ PlayerEngine  │  │
│  │ 播放控制 UI   │    │ (Pinia)          │    │ (IPC → mpv)   │  │
│  └──────────────┘    └──────────────────┘    └───────────────┘  │
│                              │                                   │
│                              │ IPC: media:update-*               │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                  Electron IPC │
                               │
┌──────────────────────────────┼───────────────────────────────────┐
│                        主进程 (Main)                              │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              MediaControlsService                          │  │
│  │                                                           │  │
│  │  ┌─────────────────┐    ┌──────────────────────────────┐  │  │
│  │  │ IPC Handler     │───▶│ echo-media-controls (Rust)   │  │  │
│  │  │ 接收渲染进程指令  │    │ NAPI-RS native addon        │  │  │
│  │  └─────────────────┘    └──────────┬───────────────────┘  │  │
│  │                                    │                      │  │
│  │  ┌─────────────────┐              │                      │  │
│  │  │ 封面下载/缓存    │◀─────────────┤                      │  │
│  │  └─────────────────┘              │                      │  │
│  └───────────────────────────────────┼───────────────────────┘  │
│                                      │                          │
│  ┌───────────────────────────────────┼───────────────────────┐  │
│  │              MpvController                                 │  │
│  │  --audio-client-name=EchoMusic                            │  │
│  │  --input-media-keys=no                                    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                               │
                    Unix Socket / Named Pipe
                               │
                               ▼
                    ┌──────────────────┐
                    │   mpv 子进程      │
                    │   音频输出标识：   │
                    │   "EchoMusic"    │
                    └──────────────────┘
```

### 2.2 改动后的效果

| 问题             | 改动前                      | 改动后                              |
| ---------------- | --------------------------- | ----------------------------------- |
| 音量合成器       | 两个条目（EchoMusic + mpv） | 一个条目（EchoMusic，来自 mpv）     |
| 静音 EchoMusic   | 无效                        | 有效（mpv 显示为 EchoMusic）        |
| Windows 媒体中心 | 两个条目（一个未知）        | 一个条目，有标题+封面               |
| macOS 控制中心   | 通过 Chromium MediaSession  | 通过 MPNowPlayingInfoCenter，有封面 |
| Linux MPRIS      | 无                          | 通过 D-Bus MPRIS v2，有封面         |

## 3. Rust Native Addon 设计

### 3.1 项目结构

```
native/
  echo-media-controls/
    Cargo.toml
    build.rs
    package.json          # NAPI-RS 构建配置
    index.d.ts            # 自动生成的 TypeScript 类型
    src/
      lib.rs              # NAPI-RS 入口，导出函数
      model.rs            # 共享数据模型
      sys_media/
        mod.rs            # 平台分发层
        windows.rs        # Windows SMTC 实现
        macos.rs          # macOS MPNowPlaying 实现
        linux.rs          # Linux MPRIS D-Bus 实现
```

### 3.2 Cargo.toml 依赖

```toml
[package]
name = "echo-media-controls"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = { version = "3", features = ["tokio_rt", "napi9"] }
napi-derive = "3"
tokio = { version = "1", features = ["full"] }
anyhow = "1.0"
tracing = "0.1"

[build-dependencies]
napi-build = "2"

# Windows: WinRT API 访问 SMTC
[target.'cfg(target_os = "windows")'.dependencies.windows]
version = "0.62"
features = ["Media_Playback", "Storage_Streams"]

# Linux: MPRIS D-Bus 服务端
[target.'cfg(target_os = "linux")'.dependencies]
mpris-server = "0.9"
tempfile = "3"

# macOS: Objective-C 桥接访问 MPNowPlayingInfoCenter
[target.'cfg(target_os = "macos")'.dependencies]
block2 = "0.6"
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-media-player = "0.3"
objc2-app-kit = "0.3"
```

### 3.3 导出 API

```typescript
// 自动生成的 index.d.ts

/** 初始化媒体控制服务 */
export declare function initialize(appName: string): void;

/** 关闭媒体控制服务，释放资源 */
export declare function shutdown(): void;

/** 更新歌曲元数据（含封面） */
export declare function updateMetadata(payload: MetadataPayload): void;

/** 更新播放状态 */
export declare function updatePlayState(payload: PlayStatePayload): void;

/** 更新播放进度 */
export declare function updateTimeline(payload: TimelinePayload): void;

/** 注册系统媒体事件回调（播放/暂停/上下首等） */
export declare function registerEventHandler(callback: (event: MediaControlEvent) => void): void;

export interface MetadataPayload {
  /** 歌曲标题 */
  title: string;
  /** 歌手名 */
  artist: string;
  /** 专辑名 */
  album: string;
  /** 封面图片原始字节（主进程下载后传入） */
  coverData?: Buffer;
  /** 封面 HTTP URL（Linux MPRIS 备用） */
  coverUrl?: string;
  /** 歌曲时长，单位毫秒 */
  durationMs?: number;
}

export interface PlayStatePayload {
  status: 'Playing' | 'Paused' | 'Stopped';
}

export interface TimelinePayload {
  /** 当前播放位置，单位毫秒 */
  currentTimeMs: number;
  /** 总时长，单位毫秒 */
  totalTimeMs: number;
}

export interface MediaControlEvent {
  type: 'Play' | 'Pause' | 'Stop' | 'NextSong' | 'PreviousSong' | 'Seek';
  /** Seek 事件的目标位置，单位毫秒 */
  positionMs?: number;
}
```

### 3.4 各平台实现要点

#### Windows (SMTC)

- 使用 `windows` crate 的 `Windows::Media::Playback` 模块
- 通过 `MediaPlayer` 创建 SMTC 会话，设置 `CommandManager` 处理媒体键事件
- 封面通过 `InMemoryRandomAccessStream` 将图片 Buffer 写入，设置到 `DisplayProperties.Thumbnail`
- 需要在后台线程运行 WinRT 事件循环

#### macOS (MPNowPlayingInfoCenter)

- 使用 `objc2-media-player` crate 访问 `MPNowPlayingInfoCenter` 和 `MPRemoteCommandCenter`
- 封面通过 `NSImage(data:)` 创建，包装为 `MPMediaItemArtwork` 设置到 `nowPlayingInfo`
- 注册 `MPRemoteCommandCenter` 的 `playCommand`、`pauseCommand`、`nextTrackCommand` 等
- macOS 要求在主线程操作 UI 相关 API

#### Linux (MPRIS D-Bus)

- 使用 `mpris-server` crate 实现 `org.mpris.MediaPlayer2` 和 `org.mpris.MediaPlayer2.Player` 接口
- 封面通过 `mpris:artUrl` 属性传递，支持两种方式：
  - `file:///tmp/echo-music-cover.jpg`（主进程将 Buffer 写入临时文件）
  - `https://...`（直接传 HTTP URL，部分 DE 支持）
- 需要在 tokio 异步运行时中运行 D-Bus 服务

## 4. 主进程集成

### 4.1 新增文件 `src/main/mediaControls.ts`

```typescript
// 职责：
// 1. 加载 native addon
// 2. 注册 IPC handler 接收渲染进程的元数据/状态更新
// 3. 下载封面图片转为 Buffer
// 4. 将系统媒体事件转发到渲染进程

import { ipcMain, BrowserWindow, net } from 'electron';
import log from './logger';

let nativeModule: typeof import('../../native/echo-media-controls') | null = null;

export function initMediaControls(getMainWindow: () => BrowserWindow | null): void {
  // 加载 native addon
  try {
    nativeModule = require('../../native/echo-media-controls');
    nativeModule.initialize('EchoMusic');
  } catch (err) {
    log.warn('[MediaControls] Native module not available:', err);
    return;
  }

  // 注册系统媒体事件回调 → 转发到渲染进程
  nativeModule.registerEventHandler((event) => {
    getMainWindow()?.webContents.send('media-control:event', event);
  });

  // IPC: 更新元数据（渲染进程发送歌曲信息 + 封面 URL）
  ipcMain.handle('media-control:update-metadata', async (_e, payload) => {
    if (!nativeModule) return;
    let coverData: Buffer | undefined;
    // 下载封面图片
    if (payload.coverUrl) {
      try {
        coverData = await downloadImage(payload.coverUrl);
      } catch {
        // 封面下载失败不影响元数据更新
      }
    }
    nativeModule.updateMetadata({
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
      coverData,
      coverUrl: payload.coverUrl,
      durationMs: payload.durationMs,
    });
  });

  // IPC: 更新播放状态
  ipcMain.handle('media-control:update-state', (_e, payload) => {
    nativeModule?.updatePlayState(payload);
  });

  // IPC: 更新播放进度
  ipcMain.handle('media-control:update-timeline', (_e, payload) => {
    nativeModule?.updateTimeline(payload);
  });
}

export function destroyMediaControls(): void {
  nativeModule?.shutdown();
  nativeModule = null;
}

/** 下载图片为 Buffer */
async function downloadImage(url: string): Promise<Buffer> {
  // 使用 Electron 的 net 模块，支持代理
  // 实现细节省略
}
```

### 4.2 mpv 启动参数变更

在 `src/main/mpv/controller.ts` 的 `start()` 方法中添加：

```diff
  const args = [
    '--idle=yes',
    '--pause',
    '--no-video',
    '--no-terminal',
    '--no-config',
    `--input-ipc-server=${this.socketPath}`,
    '--volume=100',
    '--audio-display=no',
    '--hr-seek=yes',
    '--volume-max=100',
    '--demuxer-max-bytes=50MiB',
    '--demuxer-max-back-bytes=10MiB',
    '--cache=yes',
    '--cache-secs=30',
    '--user-agent=Mozilla/5.0',
    '--input-media-keys=no',
+   '--audio-client-name=EchoMusic',
    '--audio-samplerate=0',
    '--audio-channels=stereo',
  ];
```

### 4.3 app.ts 集成

```diff
+ import { initMediaControls, destroyMediaControls } from './mediaControls'

  // 在 app.whenReady() 中，mpv 初始化之后：
+ initMediaControls(getMainWindow)

  // 在 before-quit 中：
+ destroyMediaControls()
```

## 5. 渲染进程变更

### 5.1 PlayerEngine (player.ts)

**删除：**

- `silentAudio` 元素及其所有 play/pause 同步逻辑
- `updateMediaMetadata()` 方法
- `updateMediaPlaybackState()` 方法
- `setMediaSessionHandlers()` 方法

**新增：**

- `updateNativeMediaMetadata(meta)` — 通过 IPC 调用主进程
- `updateNativePlayState(status)` — 通过 IPC 调用主进程
- `updateNativeTimeline(current, total)` — 通过 IPC 调用主进程

### 5.2 player store (player.ts)

**替换所有 Chromium MediaSession 调用：**

```diff
- engine.updateMediaMetadata(pendingMediaMeta)
+ engine.updateNativeMediaMetadata({
+   title: track.title,
+   artist: track.artist || '未知歌手',
+   album: track.album ?? '',
+   coverUrl: getCoverUrl(track.coverUrl, 512),
+   durationMs: (track.duration || 0) * 1000,
+ })

- engine.updateMediaPlaybackState(buildMediaState({...}))
+ engine.updateNativePlayState(this.isPlaying ? 'Playing' : 'Paused')

- engine.setMediaSessionHandlers({...})
+ // 删除，改为监听主进程转发的 media-control:event
```

**新增：监听系统媒体事件**

```typescript
// 在 init() 中
window.electron?.ipcRenderer.on('media-control:event', (_e, event) => {
  switch (event.type) {
    case 'Play':
      this.togglePlay();
      break;
    case 'Pause':
      this.togglePlay();
      break;
    case 'NextSong':
      this.next();
      break;
    case 'PreviousSong':
      this.prev();
      break;
    case 'Seek':
      this.seek(event.positionMs / 1000);
      break;
  }
});
```

## 6. Preload 层变更

在 `src/preload/index.ts` 中新增：

```typescript
mediaControls: {
  updateMetadata: (payload) =>
    ipcRenderer.invoke('media-control:update-metadata', payload),
  updateState: (payload) =>
    ipcRenderer.invoke('media-control:update-state', payload),
  updateTimeline: (payload) =>
    ipcRenderer.invoke('media-control:update-timeline', payload),
  onEvent: (func) => {
    const listener = (_event, data) => func(data)
    ipcRenderer.on('media-control:event', listener)
    return () => ipcRenderer.removeListener('media-control:event', listener)
  },
},
```

## 7. 构建与 CI 集成

### 7.1 本地开发

```bash
# 安装 Rust 工具链（如果没有）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 构建 native addon
cd native/echo-media-controls
pnpm install
pnpm build

# 回到项目根目录开发
cd ../..
pnpm dev
```

### 7.2 CI 构建 (build.yml)

在 `Install root dependencies` 之后、`Build desktop app` 之前新增步骤：

```yaml
- name: Setup Rust toolchain
  uses: dtolnay/rust-toolchain@stable

- name: Build native media controls addon
  working-directory: native/echo-media-controls
  shell: bash
  run: |
    npm install
    npm run build
```

### 7.3 electron-builder 配置

```diff
  "extraResources": [
+   {
+     "from": "native/echo-media-controls/echo-media-controls.${platform}-${arch}.node",
+     "to": "native/echo-media-controls.node"
+   },
    // ... 现有配置
  ]
```

或者将 `.node` 文件放在 `dist-electron` 中随主进程代码一起打包，具体取决于 vite-plugin-electron 的配置方式。

## 8. 实施计划

### Phase 1：解决音量合成器问题（快速修复）

1. mpv 启动参数添加 `--audio-client-name=EchoMusic`
2. 音量合成器中 mpv 显示为 "EchoMusic"
3. 不改动渲染进程，保留现有 Chromium MediaSession 作为临时方案

**预计工作量：** 1 行代码改动，立即可用

### Phase 2：Rust native addon 开发

1. 搭建 `native/echo-media-controls` 项目骨架
2. 实现 Windows SMTC（封面 + 媒体键事件）
3. 实现 macOS MPNowPlayingInfoCenter（封面 + 远程控制事件）
4. 实现 Linux MPRIS D-Bus（封面 + 媒体键事件）
5. 本地测试三个平台

**预计工作量：** 中等，Rust 代码约 800-1200 行

### Phase 3：主进程集成 + 渲染进程改造

1. 新增 `src/main/mediaControls.ts`，加载 native addon
2. 注册 IPC handler，实现封面下载逻辑
3. 渲染进程 PlayerEngine 删除 silentAudio 和 Chromium MediaSession
4. player store 替换所有 MediaSession 调用为 IPC 调用
5. 更新 Preload 层类型定义
6. CI 构建配置更新

**预计工作量：** 中等，TypeScript 改动约 200-300 行

### Phase 4：测试与优化

1. Windows：验证音量合成器单条目 + SMTC 封面显示 + 媒体键
2. macOS：验证控制中心封面显示 + Touch Bar 控制
3. Linux：验证 KDE/GNOME 媒体控制 + 封面显示
4. 边界情况：快速切歌时封面下载取消、mpv 崩溃恢复、native addon 加载失败降级

## 9. 降级策略

如果 native addon 加载失败（比如用户系统缺少运行时依赖），需要优雅降级：

1. **主进程**：`initMediaControls` 捕获加载异常，记录日志，不影响播放功能
2. **渲染进程**：检测 `media-control:update-metadata` IPC 是否可用，不可用时回退到 Chromium MediaSession（保留 silentAudio 作为 fallback）
3. **媒体键**：始终通过 Electron `globalShortcut` 工作，不依赖 native addon
