# 插件浮窗与 Now Playing

EchoMusic 插件可以声明独立的受控浮窗，用于桌面悬浮歌词、轻量工具条等场景。浮窗由主进程创建，插件只提供窗口入口脚本和样式，不直接接触 `BrowserWindow`。

## Manifest

```json
{
  "id": "dynamic-island-lyric",
  "name": "灵动岛歌词",
  "version": "1.0.0",
  "main": "index.js",
  "contributes": {
    "windows": [
      {
        "id": "island",
        "type": "floating",
        "title": "灵动岛歌词",
        "main": "island.js",
        "style": "island.css",
        "defaultWidth": 420,
        "defaultHeight": 72,
        "minWidth": 260,
        "minHeight": 56,
        "maxWidth": 720,
        "maxHeight": 180,
        "position": "top-center",
        "transparent": true,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "movable": true,
        "rememberBounds": true
      }
    ]
  }
}
```

窗口入口只允许插件目录内的 `.js` / `.mjs` 文件，样式只允许 `.css` 文件。

## 主插件入口

```js
export function activate(ctx) {
  ctx.windows.show('island');
}

export function deactivate(ctx) {
  ctx.windows.close('island');
}
```

`ctx.windows` 会自动绑定当前插件 id，不能操作其他插件的窗口。

## 窗口入口

```js
export function activateWindow(ctx) {
  const { h, createApp, ref, onMounted, onBeforeUnmount } = ctx.vue;

  const App = {
    setup() {
      const snapshot = ref(null);
      let dispose = null;

      onMounted(async () => {
        snapshot.value = await ctx.nowPlaying.getSnapshot();
        dispose = ctx.nowPlaying.onSnapshot((next) => {
          snapshot.value = next;
        });
      });

      onBeforeUnmount(() => dispose?.());

      return () =>
        h(
          'div',
          { class: 'island' },
          snapshot.value?.lyric?.lines[snapshot.value?.lyric?.currentIndex ?? -1]?.text ||
            snapshot.value?.playback?.title ||
            'EchoMusic',
        );
    },
  };

  const app = createApp(App);
  app.mount(ctx.container);
  ctx.dispose(() => app.unmount());
}
```

## Now Playing

插件浮窗通过 `ctx.nowPlaying` 读取与订阅中性的当前播放快照：

- `getSnapshot()`：读取当前快照。
- `onSnapshot(handler)`：订阅播放、歌词、主题变化。
- `command(command)`：发送播放/歌词命令。

快照包含：

- `playback`：当前歌曲、封面、时长、进度、播放状态。
- `lyric`：歌词行、当前行索引、翻译/音译开关、偏移、加载状态。
- `appearance`：深浅色、主题色、全局字体。

常用命令：

```js
ctx.nowPlaying.command('togglePlayback');
ctx.nowPlaying.command('previousTrack');
ctx.nowPlaying.command('nextTrack');
ctx.nowPlaying.command('toggleTranslation');
ctx.nowPlaying.command('toggleRomanization');
ctx.nowPlaying.command('lyricOffsetBackward');
ctx.nowPlaying.command('lyricOffsetForward');
ctx.nowPlaying.command('lyricOffsetReset');
```

## 窗口控制

窗口入口中的 `ctx.window` 只控制当前插件窗口：

- `getBounds()`
- `move({ x, y, width, height })`
- `hide()`
- `close()`
- `setIgnoreMouseEvents(ignore)`

拖拽和锁定穿透应由插件窗口 UI 自己决定，但最终移动与穿透仍通过宿主 IPC 执行。
