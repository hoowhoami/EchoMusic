# EchoMusic

<p align="center">
  <img src="build/icons/icon.png" width="128" height="128" alt="EchoMusic Logo">
</p>

<p align="center">
  <strong>EchoMusic</strong> —— 一个专为桌面端打造的简约、精致、功能强大的第三方音乐播放器。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-42.x-blue?logo=electron" alt="Electron">
  <img src="https://img.shields.io/badge/Vue-3.5-brightgreen?logo=vue.js" alt="Vue 3">
  <img src="https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Rust-napi--rs-orange?logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-orange" alt="License">
</p>

---

## ✨ 核心特性

- **极致美学**：精心适配桌面端布局，支持深浅色模式，兼顾信息密度与沉浸式体验。
- **数据安全**：官方服务器直连，数据不经过第三方服务器，保证用户数据安全。
- **音乐推荐**：支持歌曲、歌单、歌手、专辑、排行榜等内容推荐。
- **多维探索**：支持歌曲、歌手、专辑、歌单全方位搜索，快速发现心仪旋律。
- **进阶播放**：支持播放队列管理、播放模式切换、音量调节、进度拖动、倍速播放、淡入淡出切歌等核心播放能力。
- **私人 FM**：智能推荐个性化电台，发现更多好音乐。
- **听歌识曲**：支持麦克风和系统音频捕获，快速识别正在播放的歌曲。
- **歌曲详情**：支持查看歌曲档案及播放详情。
- **歌曲评论**：支持查看歌曲评论与评论楼层跳转。
- **歌词显示**：支持 LRC/YRC 逐字歌词解析、滚动同步、全屏歌词、桌面歌词。
- **音频增强**：支持 10 段 EQ 均衡器、音量均衡（基于 LUFS 响度标准化）、多种音效模式。
- **系统媒体控制**：原生集成 macOS MPNowPlayingInfoCenter、Windows SMTC、Linux MPRIS，支持系统媒体按键和进度同步。
- **系统集成**：支持窗口控制、系统托盘、托盘快捷控制、全局快捷键。
- **音频设备**：支持切换音频输出设备、独占模式输出。
- **持久化能力**：支持设置、播放历史、收藏、播放状态等本地持久化。
- **跨平台支持**：完整适配 macOS、Windows 与 Linux 系统。
- **自动更新**：内置应用更新检测与下载，支持静默更新。
- **持续集成**：完善的 GitHub Actions 配置，支持多平台自动构建与 Release 发布。

## 音质音效

- **音质**：Hi-Res、SQ(flac)、HQ(320)、标准(128)
- **音效**：钢琴、人声伴奏、骨笛、尤克里里、唢呐、DJ、蝰蛇母带、蝰蛇全景声、蝰蛇超清

## 🛠️ 技术栈

- **Desktop Shell**: [Electron](https://www.electronjs.org/) 42
- **Frontend**: [Vue 3](https://vuejs.org/) + [TypeScript](https://www.typescriptlang.org/)
- **Build Tool**: [Vite](https://vitejs.dev/)
- **State Management**: [Pinia](https://pinia.vuejs.org/) + [pinia-plugin-persistedstate](https://prazdevs.github.io/pinia-plugin-persistedstate/)
- **UI Primitives**: [Reka UI](https://reka-ui.com/)
- **CSS**: [Tailwind CSS](https://tailwindcss.com/) v4
- **Routing**: [Vue Router](https://router.vuejs.org/)
- **Package Manager**: [pnpm](https://pnpm.io/)
- **Backend Service**: [Node.js](https://nodejs.org/)（内置本地服务，进程内直接调用）
- **Audio Engine**: [libmpv](https://mpv.io/)（通过 Rust NAPI addon 进程内嵌入，零延迟直接函数调用）
- **Native Addons**: [napi-rs](https://napi.rs/)（Rust 编写的原生扩展）
  - `echo-mpv-player`：libmpv 播放引擎封装，支持淡入淡出、EQ、音量均衡
  - `echo-media-controls`：系统媒体控制集成（macOS/Windows/Linux 原生 API）

## 🖼️ 界面截图

- 首页
  ![首页](screenshots/home.png)
- 发现
  ![发现](screenshots/discover.png)
- 私人FM
  ![私人FM](screenshots/personal_fm.png)
- 听歌识曲
  ![听歌识曲](screenshots/recognize.png)
- 歌词
  ![歌词](screenshots/lyric.png)
- 歌曲详情
  ![歌曲详情](screenshots/song_detail.png)
- 歌曲评论
  ![歌曲评论](screenshots/song_comment.png)
- 播放列表
  ![播放列表](screenshots/playlist.png)
- 专辑
  ![专辑](screenshots/album.png)
- 歌手
  ![歌手](screenshots/artist.png)
- 搜索
  ![搜索](screenshots/search.png)
- 个人中心
  ![个人中心](screenshots/profile.png)
- 设置
  ![设置](screenshots/settings.png)

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9+
- [Rust](https://www.rust-lang.org/)（编译原生模块需要）
- [mpv / libmpv](https://mpv.io/)（播放引擎，macOS: `brew install mpv`，Linux: `apt install libmpv-dev`，Windows: 自行下载）

### 本地开发

1. **克隆仓库**

   ```bash
   git clone https://github.com/hoowhoami/EchoMusic.git
   cd EchoMusic
   git submodule update --init --recursive
   ```

2. **安装依赖**

   ```bash
   pnpm install
   cd server && npm install && cd ..
   ```

   在Linux下，可能会出现如下报错:

   ```bash
   Error: ENOENT: no such file or directory, open '/home/tzgml/Projects/Work/EchoMusic/node_modules/electron/path.txt'
   ```

   需手动下载并解压Electron到对应目录：

   ```bash
   cd node_modules/.pnpm/electron@42.0.1/node_modules/electron/
   mkdir -p dist
   curl -L -o /tmp/electron.zip "https://npmmirror.com/mirrors/electron/v42.0.1/electron-v42.0.1-linux-x64.zip"
   unzip -o /tmp/electron.zip -d dist/
   printf '%s' './electron' > path.txt
   ```

3. **编译Rust原生模块**

   倘若出现如下报错:

   ```bash
   Error: Cannot find module '/home/myname/EchoMusic/native/echo-mpv-player/echo-mpv-player.node'
   [error] [MpvController] Failed to load echo-mpv-player addon
   ```

   需要手动编译rust原生模块，因为\*.node文件在.gitignore中被排除：

   ```bash
     cd native/echo-mpv-player
     cargo build --release
     cp target/release/libecho_mpv_player.so echo-mpv-player.node

     cd ../echo-media-controls
     cargo build --release
     cp target/release/libecho_media_controls.so echo-media-controls.node

     cd ../..
   ```

4. **启动本地开发服务器**

   ```bash
   pnpm dev
   ```

> 开发模式下会由 Electron 主进程自动拉起本地服务端。

## 🏗️ 编译发布

项目使用 GitHub Actions 进行自动化构建。每当推送 `v*` 格式的 Tag 时，会自动触发多平台构建并将二进制包上传至 Releases。

**手动编译：**

```bash
pnpm build
```

## 📦 打包产物

- **macOS**：`dmg`、`zip`
- **Windows**：`exe (nsis)`、`portable`
- **Linux**：`deb`、`rpm`、`AppImage`、`tar.gz`

## macOS

```bash
xattr -cr /Applications/EchoMusic.app && codesign --force --deep --sign - /Applications/EchoMusic.app
```

## 交流群

- [Telegram](https://t.me/+H9vpkAJrDlViZjU1)
- QQ群: 1036693403

## 💡 灵感来源

本项目受到以下优秀开源项目的启发：

- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) - 酷狗音乐 NodeJS 版 API
- [SPlayer](https://github.com/imsyy/SPlayer) - 一个简约的音乐播放器
- [MoeKoeMusic](https://github.com/MoeKoeMusic/MoeKoeMusic) - 一款开源简洁高颜值的酷狗第三方客户端

## 📄 免责声明

本项目是基于公开 API 接口开发的第三方音乐客户端，仅供个人学习和技术研究使用。

- **数据来源**：所有音乐数据通过公开接口获取，本项目不存储、不传播任何音频文件
- **版权声明**：音乐内容版权归原平台及版权方所有，请尊重知识产权，支持正版音乐
- **使用限制**：禁止将本项目用于任何商业用途或违法行为
- **责任声明**：因使用本项目产生的任何法律纠纷或损失，均由使用者自行承担
- **争议处理**：如版权方认为本项目侵犯其权益，请通过 Issues 联系，我们将积极配合处理

**本项目不接受任何商业合作、广告或捐赠。**

## ⚖️ 开源协议

基于 [MIT License](LICENSE) 协议发布。

本项目使用 [mpv](https://mpv.io/) 作为音频播放引擎（LGPL-2.1+ / GPL-2.0+），通过动态链接方式加载。
