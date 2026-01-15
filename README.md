# EchoMusic

一个基于 Electron + Vue 3 的跨平台桌面音乐播放器。

## ✨ 特性

- 🎵 完整的音乐播放功能
- 🖥️ 跨平台支持（Windows、macOS、Linux）
- 🎨 现代化 UI 设计（Naive UI）
- ⚡ 快速开发体验（Vite）
- 🔒 类型安全（TypeScript）
- 🎭 桌面歌词支持
- 📦 代码质量保证（Prettier & ESLint）

## 🚀 技术栈

- **前端框架**: Vue 3 + TypeScript
- **构建工具**: Vite
- **UI 组件库**: Naive UI
- **桌面框架**: Electron
- **状态管理**: Pinia
- **路由**: Vue Router
- **音频播放**: Howler.js

## 📦 安装

### macOS

```bash
xattr -cr /Applications/EchoMusic.app && codesign --force --deep --sign - /Applications/EchoMusic.app
```

### Windows

直接运行安装包即可。

### Linux

```bash
chmod +x EchoMusic.AppImage
./EchoMusic.AppImage
```

## 🛠️ 开发

```bash
# 安装依赖
npm run install:all

# 启动开发服务器
npm run dev:all

# 构建应用
npm run dist:all
```

## 💡 灵感来源

本项目受到以下优秀开源项目的启发：

- [KuGouMusicApi](https://github.com/MakcRe/KuGouMusicApi) - 酷狗音乐 API
- [SPlayer](https://github.com/imsyy/SPlayer) - 现代化音乐播放器

## 📄 许可证

- [The MIT License (MIT)](https://github.com/hoowhoami/EchoMusic/blob/main/LICENSE)
