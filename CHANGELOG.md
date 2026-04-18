# Changelog

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

## [2.1.6] - 2026-04-18

### 新增

- IPC 直连架构，替代独立 HTTP Server 进程，彻底解决端口占用、代理拦截、长时间运行不可用等问题
- JS 窗口拖动方案，替代不可靠的 CSS `-webkit-app-region: drag`，彻底修复标题栏拖动被内容元素阻断的问题
- CHANGELOG.md 版本日志，CI 发布时自动写入 GitHub Release 和 Telegram 通知
- 听歌时长上报接口（listen_duration_report）

### 优化

- 安装包体积减小，移除 pkg 打包的独立 Node.js 运行时（约减少 24-37MB）
- API 请求日志格式化输出，请求与响应合并展示，包含耗时、状态码、Auth 信息
- 启动流程简化，模块在 main 进程内同步加载，不再依赖端口轮询和进程管理
- CI 构建流程精简，去掉 server 可执行文件打包步骤
- OverlayHeader z-index 从 9999 降至 50，避免覆盖 Drawer 等弹出层

### 修复

- 歌词页面播放队列打开后窗口控制按钮与播放队列右上角按钮重叠
- 长时间运行后 API 服务不可用，需重启应用才能恢复
- 电脑休眠唤醒后 API 服务端口失效
- 本地代理软件错误拦截 localhost API 请求
- 主页面内容滚动到标题栏下方时标题栏无法拖动
- 歌词页面右上角标题栏区域无法拖动
- Toast 通知组件阻断标题栏拖动区域
