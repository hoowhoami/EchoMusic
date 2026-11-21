import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// 回归：Apple Music 皮肤暂停态没有常驻 rAF，而引擎的 ResizeObserver 只会把
// 新布局写入弹簧目标，需要组件推帧（update）才能应用到 DOM。窗口 / 宿主
// 尺寸变化后必须重新推帧并在收敛后自停。这里加载组件真实源码片段，
// 用可编程时钟驱动 rAF 验证该调度行为，防止 core 升级或重构时静默失效。

const source = readFileSync('src/renderer/views/lyric/AmllMode.vue', 'utf8');

const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const script =
  // 剥离切片中的 TS 注解，VM 里以纯 JS 执行。
  slice('const rafLoop =', 'const handleVisibilityChange =').replace(
    '(timestamp: number)',
    '(timestamp)',
  ) +
  slice('const handleVisibilityChange =', 'const handleLineClick =') +
  slice('const initializePlayer =', 'onMounted(() => {') +
  '\ninitializePlayer();';

const FRAME_MS = 1000 / 60;

function harness() {
  const host = {
    isConnected: true,
    appendedChildren: [],
    appendChild(el) {
      this.appendedChildren.push(el);
    },
  };
  const observers = [];
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observedTargets = [];
      observers.push(this);
    }
    observe(target) {
      this.observedTargets.push(target);
    }
    disconnect() {
      this.observedTargets.length = 0;
    }
    trigger() {
      this.callback([], this);
    }
  }
  const windowListeners = {};
  class OpeningLyricPlayer {
    constructor() {
      this.updateDts = [];
    }
    getElement() {
      return {};
    }
    addEventListener() {}
    initializeViewport() {}
    setOverscanPx() {}
    setAlignAnchor() {}
    setAlignPosition() {}
    setEnableSpring() {}
    setEnableBlur() {}
    setEnableScale() {}
    setHidePassedLines() {}
    setWordFadeWidth() {}
    setSecondaryVisibility() {}
    setLyricLines() {}
    resume() {}
    pause() {}
    finishOpeningLayout() {}
    setCurrentTime() {}
    update(dt) {
      this.updateDts.push(dt);
    }
  }
  let now = 0;
  let pending;
  const playerRef = { value: null };
  const context = {
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    window: {
      addEventListener(type, cb) {
        windowListeners[type] = cb;
      },
      removeEventListener(type) {
        delete windowListeners[type];
      },
    },
    ResizeObserver,
    OpeningLyricPlayer,
    performance: { now: () => now },
    requestAnimationFrame(cb) {
      pending = cb;
      return 1;
    },
    cancelAnimationFrame() {
      pending = undefined;
    },
    playerRef,
    playerAreaRef: { value: host },
    // 本测试不覆盖行点击路径，提供桩避免引入其函数体内的 TS 断言语法。
    handleLineClick: () => {},
    // 暂停态 + 恒定时间轴：只有弹簧布局需要推帧，时间轴不会重复写入。
    playerStore: { isPlaying: false, playbackClock: {} },
    timeline: { getTimelineMs: () => 0 },
    lyricStore: { currentTimeOffset: 0, showTranslation: true, showRomanization: true },
    lyricLines: { value: [] },
    settings: { value: { highRefreshRate: true } },
    SET_TIME_INTERVAL: 1000 / 30,
    FRAME_INTERVAL: 1000 / 60,
    OVERSCAN_PX: 200,
    rafId: null,
    lastFrameTime: null,
    nextFrameTime: null,
    lastSetTimeAt: 0,
    settleUntil: 0,
    lastAppliedTimeMs: Number.NaN,
    openingOverlay: null,
    openingLayoutPending: false,
    openingFrames: 0,
    hostResizeObserver: null,
    cancelInitialization: undefined,
  };
  runInNewContext(script, context);
  return {
    player: playerRef.value,
    host,
    observers,
    windowListeners,
    hasPending: () => pending !== undefined,
    frame() {
      const callback = pending;
      pending = undefined;
      callback?.(now);
    },
    // 推进时钟直到循环自停；返回 false 表示超过收敛窗口仍在运行（未能自停）。
    runUntilIdle(maxFrames = 300) {
      for (let i = 0; i < maxFrames && pending !== undefined; i++) {
        now += FRAME_MS;
        this.frame();
      }
      return pending === undefined;
    },
    triggerWindowResize() {
      windowListeners.resize?.();
    },
    triggerHostResize() {
      observers.at(-1)?.trigger();
    },
  };
}

test('暂停初始化后创建宿主 ResizeObserver 与 window resize 监听并注册到引擎宿主', () => {
  const h = harness();
  assert.ok(h.player, '引擎应被创建并赋给 playerRef');
  assert.equal(h.observers.length, 1, '应创建一个宿主 ResizeObserver');
  assert.ok(h.observers[0].observedTargets.includes(h.host), 'ResizeObserver 应观察引擎宿主元素');
  assert.equal(typeof h.windowListeners.resize, 'function', '应注册 window resize 监听');
});

test('暂停态初始布局推帧在收敛窗口后自停', () => {
  const h = harness();
  assert.ok(h.hasPending(), '初始化应排帧');
  assert.equal(h.runUntilIdle(), true, '暂停态循环应在收敛窗口后自停');
  assert.ok(h.player.updateDts.length > 0, '收敛期间应调用 update 应用布局');
});

test('暂停态窗口 resize 重新推帧应用布局并在收敛后自停', () => {
  const h = harness();
  h.runUntilIdle();
  const updatesBefore = h.player.updateDts.length;
  h.triggerWindowResize();
  assert.ok(h.hasPending(), '窗口 resize 后应重新排帧');
  assert.equal(h.runUntilIdle(), true, '暂停态循环应在收敛窗口后自停');
  assert.ok(h.player.updateDts.length > updatesBefore, 'resize 后应调用 update 应用新布局');
  assert.equal(h.hasPending(), false, '收敛后不应残留待执行帧');
});

test('暂停态宿主尺寸变化（ResizeObserver 路径）同样重新推帧', () => {
  const h = harness();
  h.runUntilIdle();
  const updatesBefore = h.player.updateDts.length;
  h.triggerHostResize();
  assert.ok(h.hasPending(), '宿主尺寸变化后应重新排帧');
  assert.equal(h.runUntilIdle(), true, '暂停态循环应在收敛窗口后自停');
  assert.ok(h.player.updateDts.length > updatesBefore, '宿主尺寸变化后应调用 update 应用新布局');
});
