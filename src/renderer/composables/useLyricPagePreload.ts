import { onMounted, onScopeDispose, watch } from 'vue';
import { preloadLyricPage } from '@/views/lyric/loaders';

/** Load code while idle or approaching the artwork, without mounting a hidden page. */
export function useLyricPagePreload(provider: () => string, viewMode: () => string) {
  let idle: number | undefined;
  let timer: number | undefined;
  let mounted = false;

  const cancel = () => {
    if (idle !== undefined) window.cancelIdleCallback(idle);
    if (timer !== undefined) window.clearTimeout(timer);
    idle = timer = undefined;
  };
  const preload = () => {
    cancel();
    // This is speculative; the async component owns visible loading errors/retries.
    void preloadLyricPage(provider(), viewMode()).catch(() => {});
  };
  const schedule = () => {
    if (!mounted) return;
    cancel();
    if (window.requestIdleCallback) idle = window.requestIdleCallback(preload, { timeout: 2000 });
    else timer = window.setTimeout(preload, 500);
  };

  onMounted(() => {
    mounted = true;
    schedule();
  });
  watch([provider, viewMode], schedule);
  onScopeDispose(() => {
    mounted = false;
    cancel();
  });
  return preload;
}
