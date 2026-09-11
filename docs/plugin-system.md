# 插件系统

EchoMusic 支持在线插件源和本地插件。插件可以注册页面、侧边栏入口、设置面板、播放器按钮、歌曲菜单、快捷键和后台任务，也可以接入音源、歌词、实时频谱、独立浮窗、本地文件、SQLite、网络请求、TCP 设备服务、本地 Web 服务与备份恢复。

## 安装与安全

插件是受用户信任的本地代码，不采用 Chrome 扩展的安全沙盒。Manifest 中的 capability 用于能力声明、兼容性检查和宿主 API 开关，不能代替代码审查或来源信任。

- 优先使用已知插件源，并在安装前检查仓库、作者和更新内容。
- 插件异常时可在“插件管理”中启用安全模式；安全模式会暂时停止加载第三方插件，但保留原启用状态。
- 插件可以独立发起网络请求。核心音乐请求的数据路径与第三方插件的数据行为应分别判断。
- 声明 `tcp` 能力的插件可以直接连接本机、内网或公网的 TCP 服务，例如 OpenRGB SDK Server；此连接不使用应用的 HTTP 代理，也不提供 TLS。禁用插件、安全模式或关闭所属窗口时，宿主会释放连接。
- TCP 支持连接生命周期及单次 read/write/end 的 `AbortSignal`（进行中取消会中止整条连接）、排空发送队列后保留读取能力的 `end()`，以及连接选项 `keepAlive` / `keepAliveInitialDelayMs`。keepalive 默认关闭；end 沿用写入超时。接口定义见 `src/shared/plugin-tcp.ts`，用法见下方 TCP 网络 API 文档。
- 宿主在内存中维护插件清单、启用状态和安全模式，业务 API 的权限检查不会扫描插件目录。启动和刷新插件列表时异步读取清单；安装、更新、卸载及备份恢复/回滚会自动失效并重建对应记录。直接编辑清单或替换插件目录后，需要刷新插件列表或重启应用；失效期间不允许用旧记录继续申请能力。
- 声明 `backups` 能力的插件可以通过 `ctx.backups` 创建、检查和恢复备份，也可以用 `registerProvider()` 将插件提供的存储位置接入主程序“备份与恢复”界面；创建与恢复均需用户在宿主确认框中授权，备份内容本身不加密。

## 开发入口

插件 API、Manifest、生命周期、能力声明和完整示例由 EchoMusicPlugins 仓库维护：

- [插件开发指南](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/plugin-development.md)
- [独立浮窗与 Now Playing](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/floating-windows.md)
- [标题栏 API](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/titlebar.md)
- [任务中心 API](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/tasks.md)
- [Graphics 插件绘图 API](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/graphics.md)
- [TCP 网络 API](https://github.com/hoowhoami/EchoMusicPlugins/blob/main/docs/tcp.md)
- [官方插件源与示例插件](https://github.com/hoowhoami/EchoMusicPlugins)

宿主与插件仓库各自维护职责范围内的文档：EchoMusic 只说明插件系统的用户语义和宿主边界，具体 API 以 EchoMusicPlugins 的开发指南为准。
