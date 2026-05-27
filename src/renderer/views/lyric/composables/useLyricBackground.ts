import { ref, watch, type ComputedRef } from 'vue';
import { extractDominantColor, getNormalizedAccent } from '@/utils/color';
import { getCoverUrl } from '@/utils/cover';

/**
 * 歌词页面背景主题色取色
 * 从封面提取主色，归一化后压暗作为纯色背景
 * 确保白色文字在背景上有足够对比度
 */

// 将 hex 转为 HSL，压暗亮度后返回 hex
const darkenForBackground = (hex: string): string => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  let l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }

  // 压暗：亮度限制在 0.12 ~ 0.22 之间，保证深色背景
  l = Math.min(0.22, Math.max(0.12, l * 0.45));
  // 保持饱和度但适当降低，避免过于鲜艳
  s = Math.min(0.6, s * 0.8);

  // HSL -> RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let rr: number, gg: number, bb: number;
  if (s === 0) {
    rr = gg = bb = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue2rgb(p, q, h + 1 / 3);
    gg = hue2rgb(p, q, h);
    bb = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
};

export function useLyricBackground(coverUrl: ComputedRef<string | undefined>) {
  const backgroundColor = ref('');
  let requestSeq = 0;

  const refresh = async (url: string | undefined) => {
    if (!url) {
      backgroundColor.value = '';
      return;
    }
    const seq = ++requestSeq;
    const processedUrl = getCoverUrl(url, 300);
    const color = await extractDominantColor(processedUrl);
    if (seq !== requestSeq) return;

    if (!color) {
      backgroundColor.value = '';
      return;
    }

    // 先归一化（深色模式），再压暗作为背景
    const normalized = getNormalizedAccent(color, true);
    backgroundColor.value = darkenForBackground(normalized);
  };

  watch(coverUrl, (url) => void refresh(url), { immediate: true });

  return {
    backgroundColor,
  };
}
