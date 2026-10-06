// Share successful imports between background warmup and the async components.
// A failed warmup must not prevent the next user-initiated load from retrying.
function retryableImport<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () =>
    (pending ??= load().catch((error) => {
      pending = undefined;
      throw error;
    }));
}

export const loadLyricPage = retryableImport(() => import('./LyricPage.vue'));
export const loadAmllMode = retryableImport(() => import('./AmllMode.vue'));

export async function preloadLyricPage(provider: string, viewMode: string) {
  const amll = provider === 'host:amll' || (provider === 'host' && viewMode === 'amll');
  await Promise.all([loadLyricPage(), ...(amll ? [loadAmllMode()] : [])]);
}
