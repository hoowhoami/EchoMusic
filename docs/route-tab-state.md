# 页面 Tab 状态

页面 Tab 随当前路由历史记录保存。后退、前进和刷新同一地址时恢复选中项；新导航不带状态参数时采用页面默认值。页面缓存只负责复用数据和组件，不承担 Tab 状态保存。

## 共用实现

- 页面就地声明 Tab 的有限取值，第一项是默认值。未知值、数组值回退到默认项。
- `src/renderer/composables/useRouteTabs.ts`：每页调用一次，返回各参数对应的可写 `state`、可等待的 `select` 和页面 `isActive`。通过 `router.replace` 更新，不增加历史记录，保留业务查询参数、刷新标记和 hash。导航成功后才更新组件状态。
- `src/renderer/router/index.ts` 的 `meta.tabQueryKeys`：仅声明不影响页面实例身份的参数名，不管理各页面的 Tab 取值。
- `src/renderer/utils/routeViewCache.ts`：根据路由 meta 从组件 key 中排除 Tab 参数和 `_t`；资源路径、其他业务参数仍决定页面身份，`_t` 继续由现有刷新机制处理。

缓存实例只跟随自身资源的路由状态，失活时冻结值并拒绝写入。不同歌手、歌单、搜索词不会互相修改 Tab。需要多个 Tab 联动时，显式调用一次 `select({ tab, commentTab })`；不维护全局导航队列。快速切回原 Tab 的导航取消由 Vue Router 处理。

## 接入范围

| 页面           | 参数         | 取值（第一项默认）                             |
| -------------- | ------------ | ---------------------------------------------- |
| 搜索           | `tab`        | `song / special / album / author / lyric / mv` |
| 发现           | `tab`        | `playlists / ranks / albums / songs / artists` |
| 我最喜爱       | `tab`        | `songs / singers / users / albums / videos`    |
| 已购           | `tab`        | `songs / albums`                               |
| 播放历史       | `tab`        | `songs / stats`                                |
| 歌手详情       | `tab`        | `songs / albums / mvs`                         |
| 歌单、专辑详情 | `tab`        | `songs / comments`                             |
| 歌曲详情       | `tab`        | `detail / comment`，兼容读取 `mainTab`         |
| 歌曲评论子分类 | `commentTab` | `all / classify / hotword`                     |
| 插件管理       | `view`       | `installed / marketplace`                      |

排行榜选择弹窗、设置弹窗内的临时 Tab，以及排序、过滤器、滚动位置不属于本次保存范围。直接刷新保留当前路由时可恢复 Tab，不新增跨应用重启的全局偏好。

## 新页面接入

此工具依赖宿主按资源身份设置组件 key，当前由 `MainLayout` 的 `:key="routeViewKey"` 保证：不同资源对应不同实例，同一资源切换 Tab 保持实例。`ownerIdentity` 固定为 setup 时的身份，用来隔离缓存中的旧实例。工具不支持同一实例跨资源复用；`useRouteId.onIdChange` 不会迁移 Tab 归属。若以后修改宿主的 key 策略，必须同时调整此契约和资源切换回归。

在路由声明 `meta: { tabQueryKeys: ['tab'] }`，并在组件 setup 调用：

```ts
const {
  state: { tab: activeTab },
  select,
  isActive,
} = useRouteTabs({ tab: ['songs', 'albums', 'mvs'] });
```

字符串 Tab 可直接 `v-model="activeTab"`；数字索引在页面内使用 `computed` 转换。需要等待导航时使用 `await select({ tab: value })`。加载业务数据应监听恢复后的状态，并在挂载时加载当前项，不能只放在点击回调中。

主 Tab 和子 Tab 在同一次调用中声明，例如 `useRouteTabs({ tab: ['detail', 'comment'], commentTab: ['all', 'classify', 'hotword'] }, { tab: 'mainTab' })`。第二个参数只用于读取旧参数别名；路由 meta 同时列出旧参数，避免兼容链接引发组件重建。

需要资源 ID 的加载在挂载、ID 初始化后执行；歌单评论要等详情元数据确定全局 ID 后加载，无需等待全部歌曲分页。异步续体触发懒加载前检查 `isActive`，失活时不为其他页面发起请求。

## 验证

`tests/route-tabs.test.mjs` 使用真实 Vue Router、Vue 自定义 renderer 和 KeepAlive，覆盖路由恢复、实例复用、资源隔离、参数校验、兼容别名、多参数原子更新与取消导航。`tests/route-tab-loading.test.mjs` 检查恢复非默认项的数据加载入口。另保留搜索导航和插件市场回归测试。
