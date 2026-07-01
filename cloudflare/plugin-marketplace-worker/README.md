# EchoMusic Plugin Marketplace Worker

这个 Worker 只提供在线插件热度统计。EchoMusic 客户端安装/更新在线插件时仍然使用原来的下载逻辑，也就是插件源里的 `downloadUrl`，并继续尊重用户配置的 GitHub 加速地址；安装成功、更新成功、失败时再向 Worker 上报统计事件。

## API

- `POST /v1/plugins/stats`
  - 请求：`{ "plugins": [{ "sourceId": "...", "pluginId": "..." }] }`
  - 响应：每个插件的 `installCount/updateCount/failureCount/score`

- `POST /v1/plugins/events`
  - 请求：`{ "event": "install" | "update" | "failure", "plugin": { ... } }`
  - 行为：安装成功、更新成功、安装失败分别累计对应计数

## 部署

```bash
cd cloudflare/plugin-marketplace-worker
pnpm dlx wrangler@latest d1 create echomusic-plugin-stats
```

把输出的 `database_id` 写入本地的 `wrangler.toml`，然后初始化表：

```bash
pnpm dlx wrangler@latest d1 execute echomusic-plugin-stats --remote --file schema.sql
pnpm dlx wrangler@latest deploy
```

注意要带 `--remote`，否则表可能只创建在本地预览数据库里，自定义域名访问线上 Worker 时会因为远程 D1 没有表而返回 500。

如果你更喜欢全局安装，也可以先执行 `npm install -g wrangler`，之后继续用 `wrangler ...`。

提交到公开仓库前，建议把 `wrangler.toml` 里的 `database_id` 保持为占位符。D1 的 `database_id` 不是访问密钥，但属于部署资源标识；真正不能提交的是 Cloudflare API Token、`.dev.vars`、`.wrangler/` 这类本地状态和密钥文件。

部署完成后，把客户端常量 `DEFAULT_PLUGIN_MARKETPLACE_STATS_API_URL` 改为你的 Worker 域名，或在构建主进程时设置：

```bash
ECHOMUSIC_PLUGIN_STATS_API_URL=https://your-worker.example.com pnpm run build
```

可以用下面的请求快速验证线上 D1 是否可用：

```bash
curl https://your-worker.example.com/health
curl -X POST https://your-worker.example.com/v1/plugins/stats \
  -H 'content-type: application/json' \
  --data '{"plugins":[{"sourceId":"github:hoowhoami/echomusicplugins","pluginId":"test"}]}'
```

## 统计口径

- `installCount`：客户端完成新安装后上报。
- `updateCount`：客户端完成插件更新后上报。
- `failureCount`：下载校验/上游失败或客户端安装失败时累计。
- `score`：`安装/更新总量 * 3 + 今日安装/更新量 * 5 - 失败量 * 2`，用于“热度”展示，可以按实际运营口径调整。

## 安全边界

Worker 不代理安装包，也不参与插件下载决策；它只接收客户端上报的插件标识和版本等统计元数据。
