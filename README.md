# EchoMusic

<p align="center">
  <img src="assets/icons/icon.png" width="128" height="128" alt="EchoMusic Logo">
</p>

<p align="center">
  <strong>EchoMusic</strong> —— 一个专为桌面端打造的简约、精致、功能强大的第三方酷狗概念版音乐播放器。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Flutter-v3.27.0-blue?logo=flutter" alt="Flutter">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-brightgreen" alt="Platform">
  <img src="https://img.shields.io/badge/License-MIT-orange" alt="License">
</p>

---

## ✨ 核心特性

- 🎨 **极致美学**：基于 Material Design 3 设计，支持深浅色模式，适配桌面端大屏体验。
- 🔍 **多维探索**：支持歌曲、歌手、专辑、歌单全方位搜索，快速发现心仪旋律。
- 🎵 **进阶播放**：支持高潮片段标记（Firefly 效果）、播放进度精确控制、播放队列管理。
- 💬 **歌曲详情与评论**：查看歌曲详细信息及用户评论。
- 📋 **歌词复制**：一键复制完整歌词到剪贴板，支持 ESC 键快速关闭歌词页。
- 📦 **跨平台支持**：原生适配 macOS、Windows 与 Linux 系统。
- 🛠️ **持续集成**：完善的 GitHub Actions 配置，支持全平台自动编译与 Release 发布。

## 🛠️ 技术栈

- **Frontend**: [Flutter](https://flutter.dev/) (Desktop)
- **State Management**: [Provider](https://pub.dev/packages/provider)
- **Networking**: [Dio](https://pub.dev/packages/dio)
- **Backend Service**: [Node.js](https://nodejs.org/) (Custom built-in server)
- **Persistence**: [Shared Preferences](https://pub.dev/packages/shared_preferences)

## 界面截图

- 首页
  ![首页](screenshots/home.png)
- 发现
  ![发现](screenshots/discover.png)
- 歌词  
  ![歌词](screenshots/lyric.png)
- 歌曲详情
  ![歌曲详情](screenshots/song_detail.png)
- 歌曲评论
  ![歌曲评论](screenshots/song_comment.png)    
- 播放列表
  ![播放列表](screenshots/playlist.png)
- 搜索
  ![搜索](screenshots/search.png)
  ![搜索](screenshots/search_hot.png)
  ![搜索](screenshots/search_suggest.png)  
- 设置  
  ![设置](screenshots/settings.png)


## 🚀 快速开始

### 前置要求

- [Flutter SDK](https://docs.flutter.dev/get-started/install) (推荐最新稳定版)
- [Node.js](https://nodejs.org/) (用于本地服务端依赖)

### 本地开发

1. **克隆仓库**
   ```bash
   git clone https://github.com/hoowhoami/EchoMusic.git
   cd EchoMusic
   ```

2. **安装服务端依赖**
   ```bash
   cd server
   npm install
   cd ..
   ```

3. **获取 Flutter 依赖**
   ```bash
   flutter pub get
   ```

4. **启动应用**
   ```bash
   # 根据你的系统选择
   flutter run -d macos
   flutter run -d windows
   flutter run -d linux
   ```   

## 🏗️ 编译发布

项目使用 GitHub Actions 进行自动化构建。每当推送 `v*` 格式的 Tag 时，会自动触发多平台构建并将二进制包上传至 Releases。

**手动编译：**
```bash
flutter build macos --release
flutter build windows --release
flutter build linux --release
```

## MacOS

```bash
xattr -cr /Applications/EchoMusic.app && codesign --force --deep --sign - /Applications/EchoMusic.app
```

## 交流群
- [Telegram](https://t.me/+H9vpkAJrDlViZjU1)

## 💡 灵感来源

本项目受到以下优秀开源项目的启发：

- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) - 酷狗音乐 NodeJS 版 API
- [SPlayer](https://github.com/imsyy/SPlayer) - 一个简约的音乐播放器
- [MoeKoeMusic](https://github.com/MoeKoeMusic/MoeKoeMusic) - 一款开源简洁高颜值的酷狗第三方客户端

## 📄 免责声明

本软件仅供学习交流使用。所有音乐资源均来自第三方接口，EchoMusic 仅提供技术展示，不存储任何音源文件，亦不参与任何版权商业行为。

## ⚖️ 开源协议

基于 [MIT License](LICENSE) 协议发布。
<!-- trigger -->
