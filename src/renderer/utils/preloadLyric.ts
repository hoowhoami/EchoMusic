// 预加载歌词页面组件,避免首次打开时的白屏
let lyricComponentPromise: Promise<any> | null = null;

export function preloadLyricComponent() {
  if (lyricComponentPromise) return lyricComponentPromise;

  lyricComponentPromise = import('@/views/Lyric.vue');
  return lyricComponentPromise;
}

// 在应用启动后延迟预加载
export function schedulePreloadLyric() {
  // 等待主界面加载完成后再预加载
  setTimeout(() => {
    preloadLyricComponent();
  }, 2000);
}
