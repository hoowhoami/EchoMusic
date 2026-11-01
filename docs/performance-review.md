# EchoMusic 全代码库静态性能审查报告

- **审查日期**：2026-11-02
- **基线版本**：main @ 09bd3da4（`feat: 优化在线插件网络错误分类提示`）
- **审查方式**：静态只读审查（未运行、未打点、未修改任何代码），按区域分 5 路深度审查后汇总
- **审查范围**：`src/`（renderer / main / preload / shared / desktop-lyric / plugin-window，约 19.3 万行）、`native/`（9 个 Rust/C++ 子项目热路径约 4.9 万行）、`vite.config.mts` 等构建配置、`server/`（第三方 KuGouMusicApi 子模块，只读审查、仅提建议）
- **排除**：`plugins/` 插件目录、`node_modules/`、`dist*` 构建产物、`target/` 构建产物

---

## 总体评价

代码库整体工程质量**显著高于典型 Electron 音乐播放器的平均水平**：

- 渲染层：路由 100% 懒加载、自研虚拟列表全面覆盖大列表、播放热路径有系统性节流（timeupdate 250ms、MediaSession 2s）、历史性能问题（歌词行切换 122ms 长帧）已按正确方案修复且有注释沉淀。
- 主进程：下载完全流式、日志异步化、自带 IPC 同步占用哨兵（>50ms 告警）与事件循环卡顿探测器、定时器与窗口生命周期管理几乎无泄漏。
- Native：实时音频回调全程 `try_lock` + 预分配 scratch、Condvar 阻塞无忙等、generation 失效设计严密。
- Shared/preload：几乎纯类型化、IPC 有 patch 增量 + 签名去重 + 节流三重优化。

当前性能债务集中在**五类结构性问题**：

| # | 结构性问题 | 涉及区域 | 严重度 |
|---|---|---|---|
| 1 | O(n×m) 歌曲去重在 4 处重复手写双重循环（无统一键集工具） | renderer 状态层 | 高 |
| 2 | 同步原生 SQLite 存储层：所有 KV/队列/历史/插件 SQL 都在主进程线程同步执行 | 主进程 + echo-sqlite-store | 高 |
| 3 | 本地音乐扫描 music-metadata 在主进程解析且 `duration:true` 全文件扫描、无增量机制 | 主进程 | 高 |
| 4 | 常驻 UI 高频更新路径：PlayerBar 每 250ms 全组件 diff、桌面歌词每帧 DOM 查询+强制布局、任务栏歌词无节流 rAF | renderer 组件层 | 高 |
| 5 | 桌面歌词窗口全量装载主应用运行时；preload 全局 JSON 往返双重序列化 | 构建/preload | 高 |

---

## 执行摘要（TOP 12 关键发现）

| 编号 | 位置 | 问题 | 影响 | 可行性 |
|---|---|---|---|---|
| R-H1 | `stores/playlist/queueActions.ts:400-410` | 队列批量追加去重 O(n×m) 逐条 `.some()` 扫描 | 高（万级队列+千级歌单=千万次比较） | 容易 |
| R-H2 | `stores/playlist/favoritesActions.ts:586-596` 等 | 批量加歌/收藏去重 O(n×m) 双重线性扫描 | 高 | 容易 |
| R-H3 | `composables/useAudioEffectPlaza.ts:72-99` + `stores/audioEffectPlazaCache.ts` | 音效市场大 reactive 记录被逐条时长回填反复击穿，computed 全量重排 | 高 | 中等 |
| C-H1 | `layouts/PlayerBar.vue:753-813` | `player.currentTime`（250ms）被 PlayerBar 巨型根组件模板直接引用，每秒 4 次全组件 render+diff | 高 | 容易~中等 |
| C-H2 | `desktopLyric/DesktopLyricView.vue:119-261` | 桌面歌词每帧 querySelectorAll + 读写交错强制同步布局，60fps 无上限 | 高 | 容易 |
| C-H3 | `taskbarPlayer/useTaskbarLyrics.ts:26-36` | 任务栏逐字歌词无帧率上限 rAF 经 Vue 响应式每帧驱动全部字符样式 | 中~高 | 容易 |
| M-H1 | `storage/kv.ts`、`ipc/storage.ts:18-116`、`plugins/sqlite.ts` | 全部存储为同步 native SQLite 调用，运行在主进程线程；插件 SQL 无执行时长限制 | 高 | 中等 |
| M-H2 | `media/audioMetadata.ts:32-49`、`localMusic.ts:11-59` | music-metadata 主进程解析 + `duration:true` 全文件读 + 无增量扫描 | 高 | 容易~中等 |
| M-H3 | `settingsBackup.ts:158-431` | 设置备份同步 stringify/parse 最大 512MB，主进程冻结 5~20s | 高（低频单次） | 中等 |
| P-H1 | `desktop-lyric/main.ts:1-33` | 桌面歌词浮窗装载 vue-router + 完整插件运行时 + 全量 style.css（约 490KB JS + 94KB CSS） | 高 | 中等 |
| P-H2 | `preload/index.ts:294-318` | 全部 300+ IPC 参数做 JSON stringify→parse 往返（结构化克隆已保证安全），双重序列化税 + 嵌套 TypedArray 被破坏 | 高 | 容易~中等 |
| P-H3 | `ipc/cloud.ts:14`、`plugins/installer.ts:8`、`plugins/webServer.ts:4`、`ipc/settings.ts:18` | music-metadata / node-stream-zip / ws / font-list 在主进程启动路径静态加载 | 高（冷启动） | 容易 |

> 完整清单见下文各章节。编号规则：R=渲染状态层，C=渲染组件层，M=主进程，P=preload/shared/构建，N=native，S=server。

---

## 一、渲染进程 · 状态与服务层

**审查范围**：stores(36 文件)、services(8)、composables(28)、utils(65)、tasks(5)、models(10)、api(17)，约 41k 行。

### 历史问题验证结论

**122ms 歌词行切换长帧问题已确认修复**，方案与历史记录一致：

- `src/renderer/stores/sqlitePersist.ts:147-178`：已从 `$subscribe`（对整个 `$state` 的 deep watch）改为显式 `watch(() => watchedKeys.map(key => store.$state[key]), …, { deep: true })`，把 deep 遍历限定在持久化 pick 字段内；`playlist` store 整体排除（sqlitePersist.ts:100）。
- `src/renderer/stores/lyric.ts:948-975`：候选歌词缓存已移至模块级非响应式 `Map`（`candidateDetailStoreMap`/`candidatePreviewStoreMap`），LRU 上限 128；组件通过标量 `candidateCacheRevision`（lyric.ts:1016）建立更新依赖。
- `lyricResultCache` 同为模块级 LRU（上限 32，lyric.ts:928-946）；歌词行索引用二分查找（lyric.ts:1179-1200、useLyricTimeline.ts:27-49）；逐字高亮仅在歌词页打开时更新（lyric.ts:1460-1480）。

### 高严重度

#### R-H1. 队列批量追加去重为 O(n×m) 逐条 `.some()` 扫描
- 位置：`src/renderer/stores/playlist/queueActions.ts:400-410`（`appendToPlaybackQueue`），另 :368-371 对 incoming 自身去重为 O(m²)。
- 问题：向队列添加歌单时对每首新歌线性扫描整个现有队列；`helpers.ts:190-201` 已有 Set 版 `mergeQueueSongs` 却未复用。万级队列 + 千级歌单 = 千万次 `isSameSong`（每次含多次 String/trim/toLowerCase 分配）。
- 建议：先构建 `Set<resolveSongQueueKey>`（含 `id:` 兜底），循环内 O(1) 查询；incoming 去重复用 `dedupeSongs`。

#### R-H2. 批量加歌/收藏去重同样是 O(n×m)
- 位置：`src/renderer/stores/playlist/favoritesActions.ts:586`（同步到收藏的匹配 filter）、:590-596（循环内每首歌 `existingSongs.some(...)`）、:469/:493/:764（单歌路径）、`applyFavoriteChange` :145-147。
- 问题：批量导入上千首歌到上万首大歌单时为 10⁷ 级比较，且发生在网络批次循环之间。
- 建议：预构建 `Set<string>`（`mx:`/`hash:` 键，语义与 `isSameSong` 一致，参考 `resolveFavoriteSongKeys`），一次 O(n+m)。

#### R-H3. 音效市场列表 computed 全量 filter+sort，被逐条时长回填反复击穿
- 位置：`src/renderer/composables/useAudioEffectPlaza.ts:72-99`（`sortCacheEntries`/`marketItems`/`marketSearchResults`），数据源 `src/renderer/stores/audioEffectPlazaCache.ts:23-27,112-117`。
- 问题：`effectPlazaCacheState.effects` 是 `reactive()` 大记录（全市场目录数千条）；`marketItems` computed 每次失效都全量 O(n log n)。`effectPlazaSync.ts:106-148` 时长回填每解析一条就修改 reactive entry → 市场页打开则立即全量重排。磁盘写入有 500ms 防抖，但**响应式失效没有合并**。
- 建议：时长/合并批量写入后统一 bump 一个模块级 `revision` 标量（shallowRef），computed 改为依赖标量 + 读 `toRaw` 快照；或 effects 改为 shallowRef 整体替换。

### 中严重度

#### R-M1. 运行时会话 deep watch：队列全量 traverse + 全量 JSON 序列化 IPC
- 位置：`src/renderer/stores/player.ts:1186-1207`，数据源 `stores/player/session.ts:10-18`、`src/shared/playerSession.ts:5-26`。
- 问题：session 含 `currentPlaylist`（整个队列数组）。`deep: true` 对返回值全量 traverse；任何使队列数组引用变更的写（如 playback.ts:137-160 元数据 commit 的整体 `replace(queue.songs)`）都触发一次**全队列 JSON.parse(JSON.stringify)+ IPC**，无防抖。万曲队列单次可达数 MB、数十 ms。
- 建议：改为标量 watch（`currentTrackId`、`nativeTrackSeq`、`currentAudioUrl`、`currentSourceQueueId`、队列 revision 等），命中后再读取并序列化 session；或回调内用 `lastSyncedKey`（revision+trackId）去重。

#### R-M2. `appendQueueSong` / `toRawSongList` 每次追加单曲重建整条队列数组
- 位置：`src/renderer/stores/playlist/helpers.ts:89-98,203-209`；调用点 `personalFmActions.ts:213`（FM 每首歌 commit）、:586-588、`playback.ts:159`。
- 问题：`[...queue.songs, song]` 新数组无 `__v_skip` 标记，`toRawSongList` 快速路径失效，退化为对每首旧歌执行 `toRaw(withoutEmbeddedMetadata(...))` 创建新对象。FM 逐首追加每次 O(n) 分配，纯 GC 压力。
- 建议：旧数组已 markRaw 且歌曲无 embeddedMetadata 时走 `markRaw(queue.songs.concat(toRawSong(song)))`（只处理新增项）。

#### R-M3. `removeSongsFromKnownList` O(n×m)
- 位置：`src/renderer/stores/playlist/helpers.ts:183-188`；调用点 favoritesActions.ts:143、:266-270。
- 建议：对 `songs` 预构建键 Set（与 R-H1/H2 同一工具函数）。

#### R-M4. 诊断窗口到期后 30s 采样定时器不自停
- 位置：`src/renderer/utils/rendererMemoryDiagnostics.ts:162-187`（setInterval 于 :169）。
- 问题：开启"10 分钟临时诊断"后若不手动关闭，每 30s 的 `document.querySelectorAll('*')` 全量 DOM 统计 + 全 img/canvas 遍历 + IPC 内存快照将**持续到应用退出**。
- 建议：tick 回调内检查 `logDiagnosticUntil`，过期即 `stopTimer()`。

#### R-M5. sqlitePersist 残留：omit/true 型 store 仍全量 deep watch；lyric 三个 map 无上限
- 位置：`sqlitePersist.ts:150-179`；`setting.ts:812-829`（omit 型，约 100 个状态键全量 watch）、`listenReport.ts:25`、`device.ts:24`（persist:true）；`lyric.ts:1667-1682` pick 含 `timeOffsetMap`/`manualLyricMap`/`embeddedLyricSelectionMap`。
- 问题：omit 型等价于"除 12 个键外全量 deep watch + structuredClone 整状态 + 全量深比较"，新增大字段会静默劣化；lyric 三个 map 以歌曲 hash 为键**只增不减**，且每次 adjustTimeOffset 都触发对整个 map 的 deep traverse + clone，持久化体无限膨胀。
- 建议：三个 map 加容量上限（如 LRU 512）；团队约定 persist 一律用 pick 白名单。

#### R-M6. 本地快捷键每次 keydown 重建映射并解析 accelerator
- 位置：`src/renderer/utils/shortcuts.ts:508-523`（handler）、`resolveShortcutMap` :367-395、`acceleratorToKeys` :322-360。
- 问题：非输入态每次按键执行 ~15 次标签解析 + ~15 次 accelerator 解析，完全可缓存。
- 建议：模块级缓存解析结果，watch `shortcutBindings`/`defaultShortcutLabels`/`globalShortcutBindings` 失效。

#### R-M7. 歌词过滤按行 `new RegExp` 编译大正则
- 位置：`src/renderer/stores/lyric.ts:903-911`（`testLyricFilter`），调用链 `utils/lyricFilter.ts:18-58` → `views/lyric/LyricScroller.vue:79,178`。
- 问题：`DEFAULT_LYRIC_FILTER_PATTERN` 为 100+ 字符多分支正则；`buildFilteredLyricEntries` 对每一行编译一次；`resolveVisibleLyricIndex` 行切换时最坏 O(n) 次编译。
- 建议：以 pattern 字符串为 key 缓存已编译 RegExp（`Map<string, RegExp>`）。

### 低严重度（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| R-L1 | `stores/player.ts:893-963` | `settingStore.$subscribe`（默认 deep）做 14 个标量对比，全状态 traverse | 改 14 个目标字段的数组 watch（同 sqlitePersist 修复模式） |
| R-L2 | `queueActions.ts:526-537` | 每次切歌决策重建 validIds Set | 已有早退，维持现状亦可 |
| R-L3 | `player/playback.ts:841-857` | random 模式每次决策 O(n) 字符串分配 | 增量维护 shuffleTrackIds |
| R-L4 | `personalFmActions.ts:123-129,174-192` | FM 队列随播放累积无裁剪，切歌 O(n) | FM 队列历史上文截断（如保留最近 200 首） |
| R-L5 | `favoritesActions.ts:24-25` | 模块级歌单缓存按歌单数增长 | 有 resetUserCollections 清理，可接受 |
| R-L6 | `playback.ts:911-932` | flush:'sync' watch 的 getter 内联 FM 完整 next 决策 | FM 大队列可感，中优先级 |
| R-L7 | `useAudioEffectPlaza.ts:80-97` | 搜索每键全量过滤+排序（数千条） | 加 200ms 防抖 |
| R-L8 | `services/cloudAudioIndex.ts:9-27,112-140` | 4 个索引 Map 无上限 + 串行分页 | 账号切换已清理；分页可并发 2-3 路 |
| R-L9 | `audioEffectPlazaCache.ts:69-92` 等 | 防抖 flush 全量 JSON.stringify 持久化 | 写盘合并良好，可不动 |
| R-L10 | `stores/theme.ts:188-189,361,390` | 背景键含完整 data-URL 字符串比较 | 改引用相等 + crop 序列化 |
| R-L11 | `tasks/pluginUpdateTaskBridge.ts:16-108` | deep 遍历插件条目数组 | 数量小、有清理，可接受 |
| R-L12 | `utils/request.ts:277-298` | 每请求摘要日志字符串拼接 | 仅调试用途，保持 |
| R-L13 | `composables/useLyricPortrait.ts` | 轮播 interval 依赖调用方 dispose | 唯一调用方已正确 dispose，现状良好 |

---

## 二、渲染进程 · 组件与视图层

**审查范围**：components、views、nowPlaying、layouts、miniPlayer、desktopLyric、taskbarPlayer、router、main.ts、App.vue、icons.ts、vite.config.mts。

**总体**：良以上。路由 21 个全懒加载；自研 `useVirtualList` 统一覆盖歌单/本地/搜索/历史/云盘/队列，`VirtualGrid` 带 `virtualThreshold:48` 自动降级 + `content-visibility:auto`；timeupdate 引擎层 250ms 节流（`utils/player.ts:216`）；AMLL 模式 30fps 节流 + `document.hidden` 停帧；流体背景为手写 WebGL（非 Pixi），30fps 限帧 + contextlost 完整处理；封面 `loading="lazy"` + CDN 尺寸压缩；`RouteKeepAlive` LRU max=30。**未发现"上千条无虚拟滚动"的歌曲级列表**。

### 高严重度

#### C-H1. PlayerBar 每 250ms 整组件重渲染
- 位置：`src/renderer/layouts/PlayerBar.vue:753-813`（进度条区）、757-761 与 802-806（`formatTime(player.currentTime)` 两处）、764（`:model-value="progressValue"`）。
- 问题：`player.currentTime` 每 250ms 更新且被 PlayerBar 根组件模板直接引用。PlayerBar 是全应用最大常驻组件之一（3 组 action strip 17+ 按钮 v-for、多个 Popover、`climaxMarks` v-for、底部挂着 `PlayerQueueDrawer`/`AddToPlaylistDialog`）。每次 timeupdate 重跑整个 render + 全树 VNode diff。
- 建议：把"时间文本×2 + SliderRoot + climaxMarks"抽成独立 `PlayerProgress.vue` 子组件，进度状态只进该子组件；或至少在 action strip 的 `template v-for` 上加 `v-memo`。注意 `playerBarActions` computed 不依赖 currentTime，拆分后可完全消除高频重渲染。

#### C-H2. 桌面歌词每帧 DOM 查询 + 每帧强制同步布局
- 位置：`src/renderer/desktopLyric/DesktopLyricView.vue:202-227`（副歌词查询）、230-261（滚动测量）、119-124（rAF 驱动）。
- 问题：`useRafFn` 默认 60fps 无上限；每帧对每条副歌词行 `querySelectorAll('.word')`（主行有按 key 缓存，副行没有）；每帧对每个渲染行读 `scrollHeight/clientHeight` 后立即写 `transform`，形成每帧一次强制布局往返（layout thrashing）；`renderLyricLines.find/filter` 每帧分配数组。
- 建议：副行 word 列表按 `line.key` 缓存（复用主行 `cachedYrcLineKey` 模式）；溢出测量移到行切换/字体变化/resize 时（ResizeObserver），帧内只用缓存值算 transform；`useRafFn` 换成 30fps 上限自管 rAF（AmllMode.vue:89-99 已有现成模式）。

#### C-H3. 任务栏歌词逐字模式：无节流 rAF 经 Vue 响应式每帧驱动全部字符样式
- 位置：`src/renderer/taskbarPlayer/useTaskbarLyrics.ts:26-36`；`TaskbarLyricLine.vue:100-113`。
- 问题：`timeMs` 每帧（60fps，高刷屏 120+）经 ref→props→computed→模板 `:style` 全响应式链路更新；逐字歌词一行 20-60 个字符 span，每帧全部重算 `backgroundPositionX` 并 patch DOM。与项目内 AmllMode（30fps + 直写 DOM）标准不一致。
- 建议：tick 内加 30fps 累计截止节流（照抄 AmllMode `FRAME_INTERVAL` 模式）；字符样式改 onMounted 注册元素 + 帧回调直写 style（照抄 `useYrcAnimation`），`timeMs` 不再逐字符响应。

### 中严重度

#### C-M1. 歌词行切换时对全部歌词行写 6 个 DOM 属性
- 位置：`src/renderer/views/lyric/LyricScroller.vue:256-274`。
- 问题：每次行索引变化遍历全部渲染行写 dataset 与 CSS 变量；`--echo-lyric-distance` 变化使所有歌词行样式失效重绘。
- 建议：只更新旧/新当前行及相邻 2-3 行；或用 CSS 兄弟选择器/`:has` 由单点 index 派生。

#### C-M2. nowPlaying/desktopLyric 同步层对大数组 deep watch
- 位置：`src/renderer/nowPlaying/sync.ts:320-333`；`desktopLyric/sync.ts:487,534`。
- 问题：`favorites` 是 `Song[]` 大数组（可上千首），`deep:true` 首次收集 O(n×字段数)，任何歌曲对象深层变化都触发。desktopLyric 两处 deep watch 只含标量/小对象，deep 冗余。
- 建议：去掉 `deep: true`；favorites 改依赖 `favorites.length` 或 key 集合引用。

#### C-M3. Sortablejs 同步打进常驻 chunk
- 位置：`components/music/PlayerQueueDrawer.vue:6`（被 PlayerBar 同步引用 → MainLayout 常驻 chunk）；另 SidebarShortcuts/SidebarLayoutEditor/PlayerBarMoreMenu/usePlayerBarSort/useTitlebarSort。
- 问题：拖拽是低频交互，但 Sortable（~40KB）进入常驻 chunk。
- 建议：`initSortable` 改 `await import('sortablejs')`（已是 async 函数）。

#### C-M4. 评论区无虚拟滚动，加载更多全量重建 presentations
- 位置：`components/music/CommentList.vue:61-97`、`CommentDrawer.vue`。
- 问题：评论无限追加可累积上千条，每次 fetchComments 追加都重建整个 `mainPresentations`/`replyPresentations` 并全量 diff。
- 建议：短期按页分块缓存（shallowRef 仅追加）；中期根评论窗口化。

#### C-M5. 播放队列虚拟行 key 混入 index
- 位置：`components/music/PlayerQueueVirtualList.vue:132`。
- 问题：key 含 `entry.index`，删除一首歌后其后所有可见行整行重挂（封面重新挂载、闪烁），与 SongList 纯数据 key 不一致。
- 建议：key 改为 `${historyKey ?? id}:${hash ?? ''}`。

#### C-M6. SongCard 每行 3 个操作按钮常驻 `will-change: transform`
- 位置：`components/music/SongCard.vue:607-624`。
- 问题：可见约 20 行 × 3 按钮 = 60 个常驻合成层；且 hover 已改用独立 `scale` 属性，`will-change: transform` 与其保护对象脱节。
- 建议：改 `will-change: scale` 或删除（用 `translateZ(0)` 单层方案）。

#### C-M7. 详情页 Sliver 吸顶头 scroll 直接写响应式，无 rAF 节流
- 位置：`components/music/DetailPageSliverHeader.vue:113-124`。
- 建议：照抄 `useVirtualList.refresh` 的 rAF 合帧模式。

#### C-M8. vite 无 manualChunks，入口 chunk 夹带设置页大组件
- 位置：`vite.config.mts:40-50`（rollupOptions 仅 4 个 html 入口，无 output 配置）。
- 问题：`App.vue:4` 同步 import SettingsDialog → Settings.vue（1474 行）进入 entry 首屏 chunk；跨 4 入口共享 vendor 被自动合并为巨型共享 chunk（旧构建 `style-*.js` 319KB）。
- 建议：SettingsDialog 改 `defineAsyncComponent(() => import(...))`（与其余 4 个 Dialog 一致）；增加 `manualChunks`（vendor-vue / vendor-ui），配合 `ANALYZE_BUNDLE=1` 验证。

### 低严重度（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| C-L1 | `package.json:42-48` | `@pixi/*` 六个包为死依赖（src 全目录无 import） | 删除依赖 |
| C-L2 | `icons.ts:1-131` | 130+ 图标全量静态导入进 entry（约 10-20KB） | 按域拆子模块，入口只引子集 |
| C-L3 | `PlayerBar.vue:209-431` | pluginPlayerBarActions 每次 badge()/visible() 重执行、playerBarActions 全数组重建 | 拆 H1 时顺带处理 |
| C-L4 | `PlayerBar.vue:476-495` | updateDrawerWidth 读布局后立即写 CSS 变量（layout thrash） | rAF 合帧 + ResizeObserver |
| C-L5 | `PlayerBar.vue:617`、`EffectPopover.vue:925`、`TitleBar.vue:727`、`CustomTabBar.vue:95` | 动态 v-for 用 `:key="index"`（列表短、频率低） | 改稳定 key |
| C-L6 | `LyricScroller.vue:414-421 vs 366-381` | watch(playbackClock) 与 33ms rAF 循环重复劳动 | watch 内 `if (rafId === null)` 才执行 |
| C-L7 | `stores/player.ts:173-182` | 全局 watch(playbackClock) 无条件驱动歌词索引（250ms） | 加"有消费者"门控（中等改动） |
| C-L8 | `views/lyric/LyricPage.vue:289-296` | mousemove 每次 clearTimeout+setTimeout | 时间戳比较法 |
| C-L9 | `components/ui/Popover.vue:147-151` | hover 打开期间 pointermove(capture) 未节流 | 16ms rAF 合帧 |
| C-L10 | `MainLayout.vue:292,296`、`style.css:515-516,572` | 多层大面积 backdrop-filter（主题可开启） | 视觉取舍，风险高，仅建议开启 backdrop 时加 `contain: paint` |

---

## 三、Electron 主进程

**审查范围**：`src/main/` 141 个文件约 3.6 万行。

### 高严重度

#### M-H1. 存储层全部为同步原生 SQLite 调用，运行在主进程线程上
- 位置：`storage/native.ts:6-42`（addon 接口全是同步签名）、`storage/kv.ts:8-40`、`storage/playbackQueues.ts:29-85`、`storage/history.ts:23-43`、`ipc/storage.ts:18-116`（17 个 IPC handler 全部直通同步函数）、`ipc/plugins.ts:546-611`、`plugins/sqlite.ts:226-311`。
- 问题：每次 KV 读写都是「主线程 → native → SQLite + JSON 序列化」同步往返；`plugins:sqlite:*` 允许插件执行任意 SQL，**无执行时长限制**——一个慢查询即可冻结整个应用（含播放进度条、桌面歌词）；播放队列、播放历史、渲染端 setting store 持久化都走这条链路。
- 建议（按收益排序）：
  1. 给 `echo-sqlite-store` 增加 N-API AsyncWorker 版本，TS 侧改 async（根治）；
  2. 过渡：`KvStorage` 加主进程内存缓存（读命中内存、写先缓存再 debounce 批量落盘，复用 `kvApplyBatch`）；
  3. 独立可先做：`pluginSqlite*` 增加 SQL 执行超时（native 侧 `sqlite3_progress_handler`）。

#### M-H2. 本地音乐/云盘扫描：music-metadata 主进程解析 + `duration:true` 全文件扫描 + 无增量机制
- 位置：`media/audioMetadata.ts:32-49`、`localMusic.ts:11-59`（4 路并发跑在主进程事件循环上）、调用方 `ipc/cloud.ts`。
- 问题：解析 CPU 全在主进程，扫描期间切歌/进度/拖窗掉帧；`duration:true` 对 MP3/CBR 触发整文件读取（无损/播客单文件数百 MB IO）；`scanLocalAudioFiles`（fileScanner.ts:76-165）每次从零全量解析，文件夹模式上限 10000 文件。
- 建议：解析移入 `worker_threads`（music-metadata 官方支持）；`duration` 两级策略（先 false 只读标签，时长懒加载）；以 `(path,size,modifiedAt)` 为键做增量扫描。

#### M-H3. 设置备份/恢复在主进程同步处理最大 512MB 的 JSON 与 base64
- 位置：`settingsBackup.ts:425-431`（同步 stringify）、:317-337（同步 parse）、:211-235（逐文件 base64 正则校验）、:158-192（全部文件 base64 进内存）、`plugins/sqlite.ts:352-371`（同步 native backup）。
- 问题：导出/导入的同步段冻结主进程 5~20 秒；`inspectedBackups` 最多 8 个、每个持有完整 archive 驻留 10 分钟（恢复路径其实会重读文件）。
- 建议：整段搬进 worker_threads；`inspectedBackups` 只保留 `{filePath,digest,summary,includes,expiresAt}`；大文件"跳过并记录"选项。

### 中严重度

#### M-M1. 音频频谱合并策略把轮询抬到最高订阅者要求（最高 60fps）
- 位置：`audioSpectrum.ts:155-201,211-243`。
- 问题：一个订阅者要 60fps 则所有订阅者都 60fps 收帧；每帧 `bins.map(...)` 新建数组 + 每订阅者一次结构化克隆。防重入/去重/死亡清理做得好（无泄漏），但轮询无上限合并。
- 建议：合并 fps 封顶 30 或对高 fps 订阅者单独降采样；bins 改 `Float32Array`（Electron 对 TypedArray 序列化更快更省）。

#### M-M2. thumbar 用 `execSync` 同步查询注册表，且每次 `nativeTheme.updated` 重复执行
- 位置：`thumbar.ts:35-51,148-156`。
- 问题：`execSync('reg query ...')` 同步 spawn（正常 30-80ms，超时上限 2s）阻塞主进程；应用内切换主题（`update-theme` 设置 `nativeTheme.themeSource`）同样触发。
- 建议：改 `execFile` 异步回调更新缓存。

#### M-M3. nowPlaying 快照全量广播（含逐字歌词数组）到所有可见窗口
- 位置：`nowPlaying.ts:231-242,276-311`。
- 问题：每次渲染端 sync 都向每个可见窗口发完整快照（含逐字 timing 数组，单首几百 KB）；desktopLyric 已有 `desktopPatch` 增量模式而 nowPlaying 未复用。
- 建议：仿 desktopPatch 支持 patch 语义；歌词 lines 仅 revision 变化时下发。

#### M-M4. 桌面歌词 hover 光标轮询：解锁态下常驻 150ms 定时器做同步原生调用
- 位置：`desktopLyric.ts:106,330-349,403-411`（`getCursorScreenPoint()` + `getBounds()` 每 150ms）。
- 问题：生命周期干净（不泄漏），但桌面歌词开着就是持续唤醒源（电池场景）。
- 建议：非锁定态优先依赖渲染层 mouseenter/leave；或放宽到 250-300ms。

#### M-M5. 设置项「读全量-改-写全量」，拖动窗口期间反复执行
- 位置：`storage/settings.ts:128-147`（`setMainAppSetting`）、:184-195（`patchDesktopLyricPersistedSettings` 内重复读两次）；触发点 desktopLyric/window.ts:72-79（160ms debounce）、window/state.ts:74-79（200ms）、miniPlayer.ts:342-370（250ms）。
- 问题：单键写入 2-3 次同步 SQLite 往返 + 全量 JSON 序列化（H-1 放大器）。
- 建议：模块级缓存 settings 快照 + 合并落盘；`patchDesktopLyricPersistedSettings` 去重复读。

#### M-M6. 插件数据写入时全量重写 key 索引
- 位置：`plugins/index.ts:342-357`。
- 问题：每写一个新键 = 读全量索引 + 写全量索引（同步）；批量初始化写 N 个键为 O(N²)。
- 建议：索引放内存 Set + 脏标记 debounce 落盘；`clearPluginStorage` 改 native 按前缀删除。

#### M-M7. 任务栏歌词心跳：窗口隐藏/全屏时仍每 2 秒调用 native
- 位置：`taskbarMediaBar.ts:334-367`。
- 建议：心跳回调增加 `win.isVisible()` 短路。

### 低严重度（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| M-L1 | `player/controller.ts:473-475,1254-1262` | `available` getter 每次访问 2-3 次 `existsSync` | `start()` 后缓存结果 |
| M-L2 | `ipc/settings.ts:1172-1181,935-956` | CHANGELOG 每次 `readFileSync` 整文件 | `fs.promises` + 模块级缓存 |
| M-L3 | `ipc/cloud.ts:183-230` | 云盘上传单文件整读进内存（上限 100MB）+ 一次 100MB 结构化克隆 | 渲染端按 offset 分片拉取，或上限降 32MB |
| M-L4 | `appIcons.ts:126-152,253-265` | 同步 IO + 同步图片解码；插件写文件触发全量刷新 | 图标缓存 + 刷新 debounce |
| M-L5 | `cache.ts` | 整文件死代码（LRUCache 主进程无引用） | 删除或接入使用点 |

### 确认无问题（正面结论）

- `eventLoopMonitor.ts:31-54`：50ms interval + unref + 仅诊断模式启动，零额外开销。
- 进度链路：native `CORE_LOOP_TICK=250ms`，`taskbarProgress.ts:15-18` 有 200ms 节流 + epsilon；desktopLyric/miniPlayer 用增量 patch 且窗口关闭时短路。**无过度 IPC**。
- `ipc/registry.ts` 自带同步占用 >50ms 告警哨兵（仅诊断模式计时）。
- 下载引擎：流式分块写盘、全局并发 3/单 owner 2、进度 200ms 节流、SHA-256 流式。实现质量高。
- `logger.ts:111-114` 显式 `sync = false` 避免同步写盘阻塞。
- 全部 setInterval（audioSpectrum/desktopLyric/taskbarMediaBar/discovery/outputRuntime/outputHost/eventLoopMonitor）均有启停配对与销毁清理，未发现泄漏。
- opencc 主进程走 `convertBatch` 异步接口（native 线程池），无同步转换热路径。
- `server.ts` 模块按需 require + 缓存，同步 IO 仅启动时。

---

## 四、preload / shared / 构建配置

### 高严重度

#### P-H1. 桌面歌词窗口全量装载主应用运行时
- 位置：`src/desktop-lyric/main.ts:1-33`、`desktop-lyric/App.vue:8-13`。
- 问题：纯展示浮窗装载 pinia + sqlitePersistPlugin + vue-router（仅 1 条路由）+ @iconify/vue + 完整插件运行时（5362 行，含 theme/moduleLoader/network/tcp）+ 全量 style.css。旧构建实测 JS 约 490KB + CSS 94KB。对比 `taskbar-player.html` 的克制隔离设计。
- 建议：(a) 去 vue-router；(b) 桌面歌词真正需要的插件歌词源注入拆成轻量子集懒加载；(c) 评估是否真需要 sqlitePersistPlugin；(d) 将 DesktopLyricView 依赖的 tooltip 内联，避免拖入 reka-ui 组件链，从 319KB 共享 chunk 解耦。

#### P-H2. preload 对所有 IPC 参数做 JSON 往返，双重序列化 + 类型语义破坏
- 位置：`src/preload/index.ts:294-318`（`toPlainIpcPayload`/`invokeWithPlainPayload`/`sendWithPlainPayload`）。
- 问题：IPC 本身走 V8 结构化克隆，JSON stringify→parse 是每条消息的纯额外税（带 WeakSet 环检测、O(n) 扫描），覆盖全部 300+ 暴露方法，包括高频的 `api:request`、`storage.*`、`mediaControls.updateTimeline`、`desktop-lyric:sync-snapshot`（80ms 节流每 tick 一次）。正确性风险：嵌套 `Uint8Array`/`Date`/`Map`/`Set`/undefined 字段经 JSON 往返退化/丢失（顶层二进制有豁免，嵌套没有）。
- 建议：默认直接 `ipcRenderer.invoke(channel, ...args)`，仅在确有环引用/bigint 需求的个别通道保留净化；或 `structuredClone` + bigint 后处理。

#### P-H3. 重型运行时依赖在主进程启动路径静态加载
- 位置：`ipc/cloud.ts:14`（music-metadata，依赖树最重）、`plugins/installer.ts:8`（node-stream-zip）、`plugins/webServer.ts:4`（ws）、`ipc/settings.ts:18`（font-list）。
- 问题：`main/index.ts:44` 的 `void import('./app')` 已 defer 入口，但 app.ts 静态引入链使四个 CJS 包全部在启动微任务中同步 require。music-metadata 仅读本地元数据时需要；node-stream-zip 仅装插件时需要。
- 建议：各调用点改 `await import(...)`（vite 已 externalize，动态 require 无障碍）；ws 延迟到首次 listen。

### 中严重度（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| P-M1 | `audioSpectrum.ts:95-115`、`shared/audioSpectrum.ts:29-30` | 频谱帧普通 `number[]` 广播，30fps×128 bins（waveform 2048）克隆成本高 | bins/waveform 改 `Float32Array`（结构化克隆快速路径） |
| P-M2 | `preload/index.ts:322-1752,713` | 单一巨型命名空间 330+ 方法，每窗口全量构建 stub；electron-log/renderer 为 preload 产物主要体积（65.6KB） | 按窗口拆 preload 多入口；~20 行 console 转发替换 electron-log/renderer |
| P-M3 | `vite.config.mts:40-50` | 无 manualChunks，跨入口共享 vendor 巨包（style-*.js 319KB） | manualChunks 拆 vendor-vue/vendor-ui，与 P-H1 联动 |
| P-M4 | `plugin-window/main.ts:2,23` | 插件浮窗静态打包 262 个图标 + 全量 Vue 命名空间 | `ctx.icons` 改惰性 Proxy |
| P-M5 | `preload/index.ts:1842,1781-1817` | resize 监听无节流，逐帧 WCO 读取 + 4 次 setProperty | rAF 合帧 |
| P-M6 | `package.json:27-28` | `ieee754`、`ms` 为无引用的运行时依赖（打进 asar） | 确认后删除 |
| P-M7 | `package.json:14-16` | 构建脚本每次全量 `npm install` server 依赖 | 改 `npm ci --omit=dev` |
| P-M8 | `package.json:13-16` | `vue-tsc --noEmit` 全量类型检查每次串行阻塞构建 | tsconfig 开 incremental，或移至 CI |

### 低严重度（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| P-L1 | `shared/lyricTextConversion.ts:75-84` | 逐字繁简转换 O(n²) 字符数组重建 | 循环外一次性缓存 `Array.from(char.text)` |
| P-L2 | `dist/index.html`（旧产物） | modulepreload 50+，首屏未压缩 JS 约 700KB | 随 manualChunks 改善 |
| P-L3 | `shared/updateNotes.ts:10,19,32` | 正则字面量在循环内 | 提取模块顶层（风格统一） |

### 核对无问题项

- `src/shared/` 几乎纯类型（plugins.ts 1132 行全类型编译擦除），正则全部模块级一次编译，无两端重复执行的重运行时逻辑。
- `preload/pluginResources.ts` contexts Map 订阅有 dispose 清理。
- contextBridge 二进制透传（api.request 对 ArrayBuffer/TypedArray 特判保留引用）设计正确。
- 高频事件监听器 `getWrappedListener` 用 WeakMap 防重复包装；各 `onXxx` 返回反注册函数。
- 4 个 HTML 入口干净；index.html 内联仅 ~30 行防闪烁主题逻辑；taskbar 有严格 CSP。
- 生产 sourcemap 默认关闭（正确）；压缩默认 esbuild（合理）。
- dependencies/devDependencies 分层策略正确：主进程 require 的包在 dependencies，渲染端 bundle 依赖全在 devDependencies。

---

## 五、native 子项目（Rust）

**总体**：显著高于一般混合项目水平。实时音频回调全程 try_lock + 预分配 scratch（除 N-M4 一处破例）、事件队列满时丢弃可丢遥测保关键事件、解码/滤波线程全部 Condvar 阻塞无忙等、WASAPI/CPAL 双后端事件驱动、session 化生命周期与 generation 失效设计严密。sqlite-store 的开销来自"全量读写模式"，是 native 侧最值得投入的改造点。

### 高影响

#### N-H1/H2.（属 server，见第六章）

### 中影响

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N-M1 | `echo-sqlite-store/src/lib.rs:14-16,73-93` | 全局单连接互斥锁 + 同步 napi：读读互斥、全量 hydrate 在 JS 主线程同步跑 | 改 `#[napi]` 异步（Task/AsyncTask + 独立 DB 线程）；拆读写连接（WAL 单写多读） |
| N-M2 | `lib.rs:1237-1338,623-637` | 删除/重排一首歌 = 全队列 JSON 解析 + 全量重写（每首歌 2 次 SQL execute） | remove 直接 `DELETE ... WHERE song_key=?` + 更新 position；reorder 批量 UPDATE |
| N-M3 | `lib.rs:1010-1039,477-510,587-621,427` | 热函数每次 `prepare`（无 `prepare_cached`）；每首歌对整个 JSON 对象深克隆 8 次（3000 首队列 = 2.4 万次深拷贝） | `prepare_cached` 一行替换；`song_field` 等改接受 `&Map` 引用取字段 |
| N-M4 | `echo-audio-player/src/output/airplay_tap.rs:61-91` | AirPlay tap 在实时音频回调内每次两次堆分配（`Vec<i16>` + `Vec<u8>`） | 模块内持 scratch Vec 重用（唯一在回调里分配的点） |
| N-M5 | `echo-audio-capture/src/buffer.rs:57-111`、`lib.rs:215-223` | push 每样本取模；snapshot 持锁逐样本拷贝（上限 64MB），阻塞 cpal 实时回调 | pow2 mask；snapshot 两段 `copy_from_slice`；彻底方案 SPSC 原子环 |
| N-M6 | `echo-upnp/src/lib.rs:126-195` | loadDevice 不查缓存每次重拉；action 命中缓存也深克隆整个设备树 | 缓存 `Arc<rupnp::Device>`；命中 TTL 直接返回快照 |
| N-M7 | `echo-airplay/src/session.rs:1277-1322,1154-1157` | feeder 线程轮询式 accept（20ms/10ms sleep）；每帧克隆 PcmFrame（几十 KB × 40fps）；discover 每次新建 tokio runtime | 阻塞式 read_timeout 代替轮询；提前 epoch 校验直接消费 pending；复用 runtime |
| N-M8 |（属 server，见第六章） | | |

### 中低影响（摘要）

| 编号 | 位置 | 问题 | 建议 |
|---|---|---|---|
| N-L1 | `echo-audio-player/decoder.rs:859,991` | 每解码帧两次发布 packet cache 统计（持锁 + Vec 分配） | 节流 500ms 或 dirty 标志 |
| N-L2 | `shared/realtime_ring.rs:127-142,3-9` | 每样本 u128 软件除法（17.6 万次/秒）+ per-sample atomic 逐槽访问 | credit 按 chunk 均摊预计算；ring 改连续缓冲+双指针 |
| N-L3 | `dispatcher.rs:96-113` | 事件队列满重试时每毫秒克隆整个事件（最长 2s） | 首次 call 失败后再克隆 |
| N-L4 | `filter.rs:198`、`cpal_shared.rs:194-196` | filter 线程每 chunk 克隆 DSP 设置；输出线程 50ms sleep 维持 | DspSettings 包 Arc；改 Condvar 等待 |
| N-L5 | `echo-sqlite-store/lib.rs:1430-1431` | 每次播放记录执行两个全表扫描清理（发生在切歌瞬间） | 按计数/定时执行 |
| N-L6 | `echo-sqlite-store/lib.rs:262-267` | blob hex 每字节一次 `format!` | 预分配 + 手写 nibble |

### 确认无问题项

- **echo-opencc**：转换器全局 `Lazy` 静态，不存在重建问题；`convert_batch` 已是 AsyncTask 异步；`set_parallel(false)` 避免额外 Rayon 池。
- **echo-native-log**：try_lock + 有回调才构造消息，无级别过滤开销。
- **echo-media-controls**：RwLock 区分读写、COM 对象只建一次、封面解码在工作线程。
- **echo-platform-adaptor** taskbar lyric：布局定时器仅 CHANGE 后启动、成功即停、失败退避至 500ms，**非常驻轮询**；UIA 探测有 1200ms 冷却。
- 音频回调内全部 `try_lock`（拿不到静音一帧）正确规避实时阻塞；`thread::sleep` 出现处均为可接受的节奏控制。

---

## 六、server 子模块（第三方 KuGouMusicApi，只读建议）

> server 为独立 git 子模块，以下建议供上游参考，不在本仓库分支实施。

| 编号 | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| S-H1 | `server/util/request.js:209,369` | 两处 `axios(requestOptions)` 均无 `timeout`（默认无限等待）也无 AbortController，上游挂起即整条链路悬挂 | 高 | `requestOptions.timeout = 10000` |
| S-H2 | `server/server.js:260` + `util/util.js:175-185` | 每请求执行 `calculateMid`（纯 JS MD5 + 32 轮 big-integer pow），而 guid 进程生命周期内不变 | 高 | 启动算一次存模块级常量（env_guid 用小 Map 缓存） |
| S-M1 | `util/memory-cache.js:20-68` | 缓存无上限；`?timestamp=` 可绕过缓存使每请求新增条目（值=完整响应体）+ setTimeout，内存无界增长；`size` 每次全量 `Object.keys()` | 中 | 计数器维护 size；加 maxEntries + LRU 逐出 |
| S-L1 | `server.js:392,257-268`、`util/crypto.js` | 每请求同步 console.log（Windows 管道同步写）；每请求重复 MD5/WebGL hash；MD5 走纯 JS CryptoJS 而非 node:crypto | 中低 | hash 请求级缓存；MD5 切 node:crypto |
| S-L2 | `server.js:287` | `express.raw({ limit: '100mb' })` 单请求内存放大上限宽松 | 低 | 内嵌服务建议收紧 |

---

## 七、做得好的地方（汇总，值得保持）

1. **历史问题修复质量高**：sqlitePersist 字段限定 watch、候选缓存模块级 LRU + 标量 revision、二分歌词索引——与 RCA 文档方案一致且实现干净。
2. **缓存普遍有界**：`lruMap.setWithLimit` 广泛使用；opencc（4096 条/2MB 预算 + inFlight 去重）、songMetadata、播放层 invalidatedGaplessSources(8)、adoptedNativeSeqs(128)、FM fmCommits(128) 都有裁剪。
3. **播放热路径节流纪律好**：MediaSession 2s、听歌历史 5s、timeupdate 1s；gapless 预备仅在结尾 30s 窗口做重活且带 key 幂等。
4. **响应式边界意识**：shallowRef 用于大 store；toRawSongList/markRaw 使队列歌曲脱离代理。
5. **异步卫生**：FM WeakMap+epoch 防重放；listenTogether 轮询防重入 + revision 隔离 + 定时器集中清理；PagedSongLoader 非响应式 + generation abort。
6. **主进程**：下载流式、日志异步、IPC 哨兵、事件循环探测器、定时器/窗口生命周期几乎无泄漏，注释记录性能权衡。
7. **native**：实时回调 try_lock + 预分配、Condvar 无忙等、事件队列满丢遥测保关键事件。
8. **构建**：路由 21 个全懒加载、主进程入口 defer、ANALYZE_BUNDLE 内置分析插件、生产 sourcemap 关闭。

---

## 八、修复路线图（本分支实施计划）

**本分支修复范围**：`src/` 渲染层与主进程、构建配置（TS/Vue 层）。**不在本分支**：native Rust 改造（需全量 cargo 构建验证，另行专项）、server 子模块（第三方仓库）、native async 化等根治性架构改动（涉及 addon 接口变更）。

| 批次 | 内容 | 预期收益 | 风险 |
|---|---|---|---|
| 1 | R-H1+R-H2+R-M3 统一歌曲键集 Set 工具 | 批量加歌/收藏/删除从 O(n×m) 降 O(n+m) | 低 |
| 2 | R-M5 lyric 三 map 容量上限 + R-M4 诊断定时器自停 | 防长期劣化 | 低 |
| 3 | R-M7 歌词过滤正则缓存 + R-M6 快捷键映射缓存 | 行切换/按键热路径 | 低 |
| 4 | C-H3 任务栏歌词 30fps 节流 | 常驻小窗帧预算 | 低 |
| 5 | C-M5 队列 key 去 index + C-M6 will-change 修正 + C-M2 sync 去 deep | 交互卡顿点与 GPU 内存 | 低 |
| 6 | P-H3 主进程四包惰性加载 + M-L1 available 缓存 + M-L2 changelog 缓存 + M-M7 心跳 isVisible | 冷启动与稳态 | 低 |
| 7 | M-M2 thumbar execSync → execFile 异步 | 最坏 2s 冻结消除 | 低 |
| 8 | C-M8 SettingsDialog 异步化 | 首屏 chunk 减负 | 低 |
| 9 | C-H1 PlayerBar 进度条子组件化 | 消除常驻每秒 4 次全组件 diff | 中 |
| 10 | P-M5 preload resize rAF 合帧 | 缩放期间 | 低 |
| 11 | R-M1 runtime session watch 标量化 | 万曲队列切歌数十 ms 消除 | 中 |
| 12 | R-H3 音效市场 revision 标量化 | 市场页同步期间不再反复整表重排 | 中 |
| 13 | R-M2 appendQueueSong 增量追加 | FM 逐首追加 GC 压力 | 中 |
| 14 | P-H2 preload JSON 往返去除 | 全局 IPC 减税 + 修复嵌套 TypedArray 隐患 | 中高（回归面大） |

**验证手段**：每批次后 `vue-tsc --noEmit` 类型检查；构建层改动用 `ANALYZE_BUNDLE=1 vite build` 对比；组件拆分回归 `route-refresh-lifecycle` keep-alive 测试。

---

## 附录：审查方法说明

- 5 路并行静态审查，逐文件阅读 + 模式 grep 交叉验证（`deep:\s*true`、`$subscribe`、`setInterval`、`Sync(`、`JSON.stringify`、`v-for`、`addEventListener`、`unwrap()`、`Mutex`、`clone()` 等）。
- 所有结论基于实际读到的代码，标注文件:行号；未运行程序（用户指示静态审查）。
- 已知历史问题（歌词行切换 122ms 长帧）作为对照验证了修复现状。
