import { ref, type ComputedRef } from 'vue';

// 写真背景亮度检测与自适应颜色

interface LuminanceOptions {
  hasPortraitGallery: ComputedRef<boolean>;
  settingStore: { lyricAdaptiveColor: boolean };
}

interface LuminanceEntry {
  top: number;
  bottom: number;
  songInfo: number;
}

const THUMB_MAX_WIDTH = 200;
const LUMINANCE_CACHE_MAX = 20;

// 从全图像素数据中采样指定屏幕坐标对应的亮度
const getPointLuminance = (
  pixelData: Uint8ClampedArray,
  canvasW: number,
  canvasH: number,
  imgEl: HTMLImageElement,
  screenX: number,
  screenY: number,
) => {
  const imgRect = imgEl.getBoundingClientRect();
  const rw = imgRect.width;
  const rh = imgRect.height;
  const cx = Math.floor(((screenX - imgRect.left) * canvasW) / rw);
  const cy = Math.floor(((screenY - imgRect.top) * canvasH) / rh);
  const s = 5;
  const sx = Math.max(0, cx - Math.floor(s / 2));
  const sy = Math.max(0, cy - Math.floor(s / 2));
  const sw = Math.min(s, canvasW - sx);
  const sh = Math.min(s, canvasH - sy);
  if (sw <= 0 || sh <= 0) return 0.5;
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (let row = sy; row < sy + sh; row++) {
    for (let col = sx; col < sx + sw; col++) {
      const i = (row * canvasW + col) * 4;
      rSum += pixelData[i];
      gSum += pixelData[i + 1];
      bSum += pixelData[i + 2];
      count++;
    }
  }
  if (count === 0) return 0.5;
  return (0.299 * (rSum / count) + 0.587 * (gSum / count) + 0.114 * (bSum / count)) / 255;
};

// 根据亮度设置 CSS 变量
const applyContrastVars = (
  root: HTMLElement,
  topLum: number,
  bottomLum: number,
  songInfoLum: number,
) => {
  const t = 0.6;
  const tl = topLum > t;
  const bl = bottomLum > t;
  const sl = songInfoLum > t;
  const s = root.style;
  s.setProperty('--pt-fg', tl ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)');
  s.setProperty('--pt-fg-hover', 'var(--color-primary)');
  s.setProperty('--pt-fg-muted', tl ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)');
  s.setProperty('--pt-btn-bg', tl ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.35)');
  s.setProperty('--pt-btn-bg-hover', tl ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.5)');
  s.setProperty('--pt-btn-border', tl ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.1)');
  s.setProperty('--pb-fg', bl ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)');
  s.setProperty('--pb-fg-hover', 'var(--color-primary)');
  s.setProperty('--pb-fg-muted', bl ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)');
  s.setProperty('--pb-btn-bg', bl ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.3)');
  s.setProperty('--pb-btn-border', bl ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)');
  s.setProperty('--pb-card-bg', bl ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)');
  // 歌曲信息卡片
  s.setProperty('--ps-fg', sl ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)');
  s.setProperty('--ps-fg-muted', sl ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)');
  s.setProperty('--ps-card-bg', sl ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)');
  s.setProperty('--ps-card-border', sl ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.08)');
  // 徽标
  s.setProperty('--pb-badge-bg', bl ? '#000' : '#fff');
  s.setProperty('--pb-badge-fg', bl ? '#fff' : '#000');
};

export function useLyricLuminance(options: LuminanceOptions) {
  const { hasPortraitGallery, settingStore } = options;

  const portraitImgRef = ref<HTMLImageElement | null>(null);
  const luminanceCache = new Map<string, LuminanceEntry>();
  let thumbCanvas: HTMLCanvasElement | null = null;
  let thumbCtx: CanvasRenderingContext2D | null = null;
  let luminanceSeq = 0;

  const analyzeRenderedImage = (img: HTMLImageElement) => {
    if (!settingStore.lyricAdaptiveColor) return;
    const root = img.closest('.lyric-view') as HTMLElement | null;
    if (!root) return;

    const url = img.src;
    const cached = luminanceCache.get(url);
    if (cached) {
      applyContrastVars(root, cached.top, cached.bottom, cached.songInfo);
      return;
    }

    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (!nw || !nh) return;

    const scale = Math.min(1, THUMB_MAX_WIDTH / nw);
    const tw = Math.round(nw * scale);
    const th = Math.round(nh * scale);

    if (!thumbCanvas) {
      thumbCanvas = document.createElement('canvas');
      thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (!thumbCtx) return;
    thumbCanvas.width = tw;
    thumbCanvas.height = th;
    thumbCtx.drawImage(img, 0, 0, tw, th);

    // 一次性读取全图像素数据
    const pixelData = thumbCtx.getImageData(0, 0, tw, th).data;

    const toolbarEl = root.querySelector('.px-6.pb-3') as HTMLElement | null;
    const controlsEl = root.querySelector('.lyric-controls-surface') as HTMLElement | null;
    const songInfoEl = root.querySelector('.lyric-photo-song-info') as HTMLElement | null;

    let topLum = 0.3;
    let bottomLum = 0.3;
    let songInfoLum = 0.3;

    if (toolbarEl) {
      const r = toolbarEl.getBoundingClientRect();
      const pts = [
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.2, r.top + r.height / 2),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.5, r.top + r.height / 2),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.8, r.top + r.height / 2),
      ];
      topLum = Math.min(...pts);
    }
    if (controlsEl) {
      const r = controlsEl.getBoundingClientRect();
      const pts = [
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.1, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.3, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.5, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.7, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.9, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.1, r.top + r.height * 0.8),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.5, r.top + r.height * 0.8),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.9, r.top + r.height * 0.8),
      ];
      bottomLum = Math.min(...pts);
    }
    if (songInfoEl) {
      const r = songInfoEl.getBoundingClientRect();
      const pts = [
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.2, r.top + r.height * 0.3),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.5, r.top + r.height * 0.5),
        getPointLuminance(pixelData, tw, th, img, r.left + r.width * 0.8, r.top + r.height * 0.7),
      ];
      songInfoLum = Math.min(...pts);
    }

    topLum *= 0.85;
    bottomLum *= 0.85;
    songInfoLum *= 0.85;

    luminanceCache.set(url, { top: topLum, bottom: bottomLum, songInfo: songInfoLum });
    // 限制缓存大小
    if (luminanceCache.size > LUMINANCE_CACHE_MAX) {
      const firstKey = luminanceCache.keys().next().value;
      if (firstKey) luminanceCache.delete(firstKey);
    }
    applyContrastVars(root, topLum, bottomLum, songInfoLum);
  };

  const onPortraitImageLoad = () => {
    const img = portraitImgRef.value;
    if (!img || !hasPortraitGallery.value) return;
    const seq = ++luminanceSeq;
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (seq !== luminanceSeq) return;
        if (!portraitImgRef.value || portraitImgRef.value !== img) return;
        analyzeRenderedImage(img);
      }, 0);
    });
  };

  const clearCache = () => {
    luminanceCache.clear();
  };

  return {
    portraitImgRef,
    onPortraitImageLoad,
    clearCache,
  };
}
