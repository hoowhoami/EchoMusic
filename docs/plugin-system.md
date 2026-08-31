# 插件系统

EchoMusic 支持在线插件源和本地插件。插件可以注册页面、侧边栏入口、设置面板、播放器按钮、歌曲菜单、快捷键和后台任务，也可以接入音源、歌词、实时频谱、独立浮窗、本地文件、SQLite、网络请求、本地 Web 服务与备份恢复。

## 安装与安全

插件是受用户信任的本地代码，不采用 Chrome 扩展的安全沙盒。Manifest 中的 capability 用于能力声明、兼容性检查和宿主 API 开关，不能代替代码审查或来源信任。

- 优先使用已知插件源，并在安装前检查仓库、作者和更新内容。
- 插件异常时可在“插件管理”中启用安全模式；安全模式会暂时停止加载第三方插件，但保留原启用状态。
- 插件可以独立发起网络请求。核心音乐请求的数据路径与第三方插件的数据行为应分别判断。
- 声明 `backups` 能力的插件可以通过 `ctx.backups` 创建、检查和恢复备份；创建与恢复均需用户在宿主确认框中授权，备份内容本身不加密。

## 开发入口

插件 API、Manifest、生命周期、能力声明和完整示例由 EchoMusicPlugins 仓库维护：

- [插件开发指南](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/plugin-development.md)
- [独立浮窗与 Now Playing](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/floating-windows.md)
- [任务中心 API](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/tasks.md)
- [官方插件源与示例插件](https://github.com/hoowhoami/EchoMusicPlugins)

宿主与插件仓库各自维护职责范围内的文档：EchoMusic 只说明插件系统的用户语义和宿主边界，具体 API 以 EchoMusicPlugins 的开发指南为准。
