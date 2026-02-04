# EchoMusic (Flutter Desktop)

使用 Flutter 复刻的 EchoMusic 桌面端。

## 运行步骤

### 1. 启动服务端

```bash
cd server
npm install
npm start
```

服务端默认运行在 `http://localhost:10086`。

### 2. 启动 Flutter 应用

```bash
# 获取依赖
flutter pub get

# 运行 (macOS)
flutter run -d macos

# 运行 (Windows)
flutter run -d windows

# 运行 (Linux)
flutter run -d linux
```

## 功能特性

- [x] 发现新歌
- [x] 排行榜
- [x] 音乐搜索
- [x] 音乐播放 (播放/暂停/切歌/进度条)
- [x] 音量控制
- [x] 响应式桌面布局
🎉 一个简约的音乐播放器
