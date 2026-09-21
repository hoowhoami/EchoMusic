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

### 更新现有 Worker

已有线上统计数据时，继续绑定原来的 D1 数据库。仓库中的 `database_id` 是占位符，不能直接用于部署，否则会出现 `binding PLUGIN_STATS_DB of type d1 must have a valid database_id specified [code: 10021]`。

```bash
cd cloudflare/plugin-marketplace-worker
pnpm dlx wrangler@latest d1 list
```

找到当前线上 Worker 使用的数据库（默认名称为 `echomusic-plugin-stats`），将其 UUID 填入 `wrangler.toml` 的 `database_id`，保留绑定名 `PLUGIN_STATS_DB`。也可以在 Cloudflare 控制台中查看现有 Worker 的 D1 绑定，再进入对应数据库查看 ID。数据库名称不能代替 UUID。

确认部署使用的是填写了真实 ID 的配置文件后执行：

```bash
pnpm dlx wrangler@latest deploy
```

如果通过 Cloudflare Builds / CI 部署，需要让构建环境使用包含该真实 ID 的配置；只修改本地文件不会影响远程构建。本次统计优化不需要建新库或执行表结构迁移。

### 首次部署

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

## 请求与缓存策略

- 客户端为统计单独维护 10 分钟持久缓存，页面每 5 分钟检查目录；切换页面和窗口聚焦会复用仍有效的统计缓存。手动刷新同时重新请求目录和统计，绕过统计缓存有效期及自动重试退避，并发刷新仍合并为同一次请求。首次展示缓存和启动时检查已安装插件都不会请求统计服务。
- 主进程合并并发统计读取，只查询缺失或过期的插件。统计读取只发送 `sourceId`、`pluginId`，每批最多 200 个，超过时分批串行读取。
- 查询失败保留原来的统计和排序依据，自动查询按 1、2、4、8、16、30 分钟退避，之后最多每 30 分钟重试；退避状态也会持久保存。成功后恢复正常缓存周期。
- 安装/更新/失败事件继续即时上报，不做自动重试，以免非幂等增量被重复计数。事件返回的统计立即写回本地缓存，较早发出的统计查询不会覆盖该结果。
- Worker 用 `json_each` 展开一批标识，通过已有复合主键连接总量和当日表：200 个插件从最多 400 次读取减少为 1 次读取，仅绑定批次 JSON 和 UTC 日期两个参数。事件仍使用 D1 batch 原子写入两张表，再执行一次读取。
- 保留旧客户端携带完整插件元数据及超量列表仅处理前 200 项的兼容行为，重复标识去重。请求体限制为 1 MiB（同时检查实际流大小），格式错误返回 400，超限返回 413，异步数据库错误返回 JSON 500。

本次更新不需要修改表结构。先部署新版 Worker，旧客户端即可受益于批量查询；客户端更新后再获得缓存和退避效果。线上应对比 `/v1/plugins/stats` 的请求量、CPU 时间及 `exceededCpu` 数量，本地 SQL 测试不能代替线上 CPU 指标。

本地回归测试（Node.js 22.13+，使用内置 SQLite）：

```bash
node --test tests/plugin-marketplace-cache.test.mjs tests/plugin-marketplace-stats.test.mjs tests/plugin-marketplace-worker.test.mjs
```

查询方案依据 [D1 JSON 支持](https://developers.cloudflare.com/d1/sql-api/query-json/)；绑定数量限制参见 [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。

## 统计口径

- `installCount`：客户端完成新安装后上报。
- `updateCount`：客户端完成插件更新后上报。
- `failureCount`：下载校验/上游失败或客户端安装失败时累计。
- `score`：`安装/更新总量 * 3 + 今日安装/更新量 * 5 - 失败量 * 2`，用于“热度”展示，可以按实际运营口径调整。

## 安全边界

Worker 不代理安装包，也不参与插件下载决策；它只接收客户端上报的插件标识和版本等统计元数据。
