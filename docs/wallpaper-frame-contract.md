# 壁纸帧率契约

壁纸窗口的帧率不是固定值：每块屏各配一档（30–240 帧，上限由屏幕刷新率压住），桌面被别的窗口挡住时按设定的 20% 省电跑，整页看不见时完全冻结。这些限制原先只作用在宿主自己的绘制循环（`src/renderer/utils/frameBudget.ts` 的 `scheduleDrawFrame`）上，插件自绘的画面走自己的循环，宿主碰不到。

从 2.3.3 起宿主把这份设定公开成契约，由插件自己遵守。

## 形态

```ts
interface WallpaperFrameMode {
  /** 目标帧率；0 表示不限（主窗口，或壁纸没设帧率）。 */
  fps: number;
  /** true 表示壁纸现在看不见，应当完全停止出帧。 */
  frozen: boolean;
}
```

- `fps` 是**上限**，不是保证值：屏幕刷新率更低时以刷新率为准，宿主也不会为插件补帧。
- `fps: 0` 与 `fps: 30` 含义不同，前者是「不限」，后者是「最多 30 帧」，不要用 0 表示暂停（暂停看 `frozen`）。
- 主窗口里的插件同样能读，拿到的是 `{ fps: 0, frozen: false }`。

## 读取方式

### 1. 歌词页插件上下文（推荐）

歌词页插件拿到的 `page` 上下文里带一份响应式设定：

```ts
const fps = computed(() => props.page.state.value.view.frame.fps);
const frozen = computed(() => props.page.state.value.view.frame.frozen);
```

`view.wallpaper`（是不是壁纸窗口）与 `view.clearBackground`（是不是仅歌词）也在同一处，可以一起判断。

### 2. window 事件（自绘循环、非歌词页插件）

```ts
const MODE_EVENT = 'echomusic:wallpaper-frame';

let mode = { fps: 0, frozen: false };
window.addEventListener(MODE_EVENT, (event) => {
  mode = (event as CustomEvent<typeof mode>).detail;
  // 冻结解除后要主动续上循环：这里就是恢复时机
});

function tick(now: number) {
  if (mode.frozen) return resumeLater(); // 冻结：彻底停住，等事件唤醒
  draw(now);
  const wait = mode.fps > 0 ? Math.max(0, 1000 / mode.fps - (performance.now() - now)) : 0;
  wait > 0 ? setTimeout(() => requestAnimationFrame(tick), wait) : requestAnimationFrame(tick);
}
```

### 3. `ctx.graphics` 动画循环

用 `ctx.graphics.createCanvas()` 拿到画布并调用 `start(draw)` 的插件**不需要做任何事**：宿主的托管循环已经按契约排帧（冻结时停住，解除后自动续上，`fps > 0` 时按目标帧率排队）。

## 注意事项

- 事件只在设定**真正变化**时派发，不要指望它每帧都来；首帧之前先按 `{ fps: 0, frozen: false }` 处理。
- 冻结期间宿主仍会让 `html` 带上 `wallpaper-frozen` 类（CSS 动画会停），但 Canvas / WebGL / Web Animations 不会自己停，必须按契约处理。
- 插件如果把画面放进 iframe（例如自带前端应用的皮肤），父窗口收到事件后需要自己 `postMessage` 转进去，跨窗口事件不会自动送达。
- 省电档是 20%，例如设定 144 帧时被挡住按 29 帧跑；插件按收到的 `fps` 执行即可，不必自己再算比例。
