import { computed, onScopeDispose, ref } from 'vue';

interface DeferredSeekOptions {
  getCurrentTime: () => number;
  seek: (time: number) => void;
}

/**
 * 在滑块交互期间仅预览进度，待 Slider 的 valueCommit 事件触发后再提交 seek。
 */
export function useDeferredSeek(options: DeferredSeekOptions) {
  const pendingSeekTime = ref<number | null>(null);
  const isDragging = ref(false);
  let globalReleaseListenersAttached = false;

  const progressValue = computed(() => [
    isDragging.value && pendingSeekTime.value !== null
      ? pendingSeekTime.value
      : options.getCurrentTime(),
  ]);

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
    if (typeof targetTime === 'number') options.seek(targetTime);
    reset();
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

  onScopeDispose(removeGlobalReleaseListeners);

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
