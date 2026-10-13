import { computed, onScopeDispose, ref, shallowRef } from 'vue';

interface DeferredSeekOptions {
  getCurrentTime: () => number;
  seek: (time: number) => void;
}

/** 已提交但尚未被上游确认的 seek。 */
interface CommittedSeek {
  time: number;
  /**
   * seek 方向，在提交那一刻确定。
   *
   * 不能在比较时现推：向前 seek 时播放头会越过目标继续前进，一旦越过，
   * 用「目标与当前位置谁大」推出来的方向就反了，确认条件随之失效。
   */
  forward: boolean;
}

/**
 * 在滑块交互期间仅预览进度，待 Slider 的 valueCommit 事件触发后再提交 seek。
 */
export function useDeferredSeek(options: DeferredSeekOptions) {
  const pendingSeekTime = ref<number | null>(null);
  const isDragging = ref(false);
  /**
   * 已提交但尚未被上游确认的 seek。
   *
   * 独立窗口（任务栏 / mini）的 seek 要经 IPC 转发到主窗口执行，新位置再同步回来，
   * 往返期间 getCurrentTime() 仍是旧值。若提交后立刻结束拖动，进度条会先闪回旧位置
   * 再跳到目标。这里在确认到达前继续显示目标值，消除那次回跳。
   *
   * 用 shallowRef：每次提交整体替换，不做字段级修改。用普通 ref 的话 Vue 会把对象
   * 包成响应式代理，超时回调里 `committedSeek.value === seek` 的引用比较永远不成立，
   * 兜底逻辑会静默失效。
   */
  const committedSeek = shallowRef<CommittedSeek | null>(null);
  let globalReleaseListenersAttached = false;
  /**
   * seek 迟迟不被确认时的兜底：切歌、播放中断等情况下上游可能永远不再报告
   * 新位置，届时必须交回实际进度，否则进度条会停在旧的目标值上。
   */
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const SEEK_CONFIRM_TIMEOUT_MS = 1500;

  const scheduleConfirmTimeout = (seek: CommittedSeek) => {
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      if (committedSeek.value === seek) {
        committedSeek.value = null;
      }
    }, SEEK_CONFIRM_TIMEOUT_MS);
  };

  const progressValue = computed(() => {
    if (isDragging.value && pendingSeekTime.value !== null) return [pendingSeekTime.value];
    const current = options.getCurrentTime();
    const seek = committedSeek.value;
    if (seek) {
      // 确认条件是「播放头已经越过目标」，而不是「进入目标邻域」。
      //
      // 向前 seek 时播放头从旧位置一路爬向目标。若按邻域确认，播放头一踏进窗口
      // 就交回实际进度，进度条会往回跳最多整个邻域宽度 —— 那正是这里要消除的
      // 抖动，只是换了个更小的幅度又来一次。越过目标时 current 已经贴近目标值，
      // 交回去看不出差别。
      //
      // 不能用「离开旧位置」判定：播放头本来就在正常前进，向前 seek 提交后立刻
      // 就会离开旧位置，会被误判成已生效而闪回旧值。
      const crossed = seek.forward ? current >= seek.time : current <= seek.time;
      if (crossed) {
        committedSeek.value = null;
        clearTimeout(confirmTimer);
        return [current];
      }
      return [seek.time];
    }
    return [current];
  });

  const removeGlobalReleaseListeners = () => {
    if (!globalReleaseListenersAttached) return;
    globalReleaseListenersAttached = false;
    window.removeEventListener('pointerup', handleGlobalRelease);
    window.removeEventListener('pointercancel', handleGlobalRelease);
    window.removeEventListener('blur', handleGlobalRelease);
  };

  const reset = () => {
    pendingSeekTime.value = null;
    isDragging.value = false;
    committedSeek.value = null;
    clearTimeout(confirmTimer);
    removeGlobalReleaseListeners();
  };

  /** 结束拖动但保留已提交的目标值，等上游确认后再交回实际进度。 */
  const endGesture = () => {
    pendingSeekTime.value = null;
    isDragging.value = false;
    removeGlobalReleaseListeners();
  };

  function handleGlobalRelease() {
    queueMicrotask(() => {
      if (isDragging.value) reset();
    });
  }

  const addGlobalReleaseListeners = () => {
    if (globalReleaseListenersAttached) return;
    globalReleaseListenersAttached = true;
    window.addEventListener('pointerup', handleGlobalRelease);
    window.addEventListener('pointercancel', handleGlobalRelease);
    window.addEventListener('blur', handleGlobalRelease);
  };

  const handleStart = () => {
    isDragging.value = true;
    pendingSeekTime.value = options.getCurrentTime();
    addGlobalReleaseListeners();
  };

  const handleValueUpdate = (value: number[] | undefined) => {
    if (!value?.length) return;
    pendingSeekTime.value = value[0];
  };

  const handleCommit = (value: number[] | undefined) => {
    const targetTime = value?.[0] ?? pendingSeekTime.value;
    if (typeof targetTime === 'number') {
      // 方向要按**播放头**当前位置判定，不是滑块拖到的位置：上游会把播放头从
      // 当前位置搬到 target，方向决定的是它从哪一侧到达。用 pendingSeekTime
      // 反推的话，一次向后拖动（滑块 300 → 30）会被算成「目标 30 不小于起点
      // 30」，方向翻转，确认条件随即失效，进度条钉在目标值上直到超时。
      //
      // 必须在 seek() **之前**读取：若上游同步应用 seek，之后再读到的已经是
      // 目标位置，方向判定就会失真。
      const playheadBeforeSeek = options.getCurrentTime();
      options.seek(targetTime);
      // 记录目标位置与方向，progressValue 在上游确认前继续显示目标值。
      const seek: CommittedSeek = {
        time: targetTime,
        forward: targetTime >= playheadBeforeSeek,
      };
      committedSeek.value = seek;
      scheduleConfirmTimeout(seek);
    }
    endGesture();
  };

  // valueCommit 仅在数值变化时触发。延后到当前 pointerup 事件结束后兜底，
  // 让同一次交互中的 valueCommit 有机会先提交最终 seek。
  const handleEnd = () => {
    queueMicrotask(() => {
      if (isDragging.value) reset();
    });
  };

  const handleCancel = () => {
    reset();
  };

  onScopeDispose(() => {
    removeGlobalReleaseListeners();
    clearTimeout(confirmTimer);
  });

  return {
    pendingSeekTime,
    isDragging,
    progressValue,
    handleStart,
    handleValueUpdate,
    handleCommit,
    handleEnd,
    handleCancel,
  };
}
