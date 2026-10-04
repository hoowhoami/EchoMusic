import {
  computed,
  nextTick,
  onScopeDispose,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';

interface PageEntryMotionOptions {
  enabled: MaybeRefOrGetter<boolean>;
  reducedMotion: MaybeRefOrGetter<boolean>;
  name: MaybeRefOrGetter<string>;
}

/** Own only the viewport's entry class, never the route component or its cache key. */
export function usePageEntryMotion(options: PageEntryMotionOptions) {
  const host = ref<HTMLElement | null>(null);
  const entering = ref(false);
  const className = computed(() => `${toValue(options.name) || 'page'}-route-enter-active`);
  const allowed = () => toValue(options.enabled) && !toValue(options.reducedMotion);
  let generation = 0;
  let disposed = false;

  const stop = () => {
    generation++;
    entering.value = false;
  };

  const replay = () => {
    stop();
    if (disposed || !allowed()) return;
    const current = generation;
    void nextTick().then(() => {
      if (disposed || current !== generation || !allowed() || !host.value) return;
      // Flush removal of the old CSS animation before reusing its class. This is
      // a style query once per navigation, not a geometry read or a frame loop.
      host.value.getAnimations();
      entering.value = true;
    });
  };

  watch(
    entering,
    (active, _, onCleanup) => {
      if (!active) return;
      const current = generation;
      let observing = true;
      onCleanup(() => {
        observing = false;
      });
      // No subtree: section entry, spinners and animated covers must not keep
      // the route class alive. Ignore transitions and non-terminating effects.
      const animations = (host.value?.getAnimations() ?? []).filter(
        (animation) =>
          'animationName' in animation &&
          animation.playState !== 'paused' &&
          animation.playbackRate !== 0 &&
          Number.isFinite(animation.effect?.getComputedTiming().endTime),
      );
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (observing && current === generation && !disposed) entering.value = false;
      });
    },
    { flush: 'post' },
  );

  watch([() => toValue(options.enabled), () => toValue(options.reducedMotion), className], stop, {
    flush: 'sync',
  });

  onScopeDispose(() => {
    disposed = true;
    stop();
  });

  return { host, entering, className, replay, stop };
}
