import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import { extractDominantColor, getNormalizedAccent, waitForAbortableDelay } from '@/utils/color';
import { coverFallbackRevision } from '@/plugins/coverFallback';
import { resolveCoverColorUrls } from '@/utils/cover';

/**
 * 歌词播放页背景主题色取色
 * 从封面提取主色，归一化后按歌词页外观模式调整亮度作为纯色背景
 * 深色档压暗保证白色文字对比度；浅色档提亮保证深色文字对比度
 */

const hexToHsl = (hex: string): { h: number; s: number; l: number } => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const hsl = { h: 0, s: 0, l: (max + min) / 2 };

  if (max !== min) {
    const d = max - min;
    hsl.s = hsl.l > 0.5 ? d / (2 - max - min) : d / (max + min);
    // 色相保持 0~1 分数约定，与 hslToHex 的 h±1/3 用法一致
    if (max === r) hsl.h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) hsl.h = ((b - r) / d + 2) / 6;
    else hsl.h = ((r - g) / d + 4) / 6;
  }
  return hsl;
};

const hslToHex = (h: number, s: number, l: number): string => {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

// 深色档：压暗，亮度限制在 0.12 ~ 0.22 之间，保证深色背景
const darkenForBackground = ({ h, s, l }: { h: number; s: number; l: number }): string => {
  const nextL = Math.min(0.22, Math.max(0.12, l * 0.45));
  // 保持饱和度但适当降低，避免过于鲜艳
  const nextS = Math.min(0.6, s * 0.8);
  return hslToHex(h, nextS, nextL);
};

// 浅色档：提亮，亮度限制在 0.86 ~ 0.94 之间，形成柔和的封面色浅调背景
const lightenForBackground = ({ h, s, l }: { h: number; s: number; l: number }): string => {
  const nextL = Math.min(0.94, Math.max(0.86, l * 1.75));
  // 降低饱和度得到柔和粉彩感，避免背景过艳干扰歌词阅读
  const nextS = Math.min(0.45, s * 0.65);
  return hslToHex(h, nextS, nextL);
};

const resolveCoverBackgroundColor = (hex: string, isDark: boolean): string => {
  // 先按目标外观归一化主题色（灰度封面回落默认主题色），再调整亮度
  const normalized = getNormalizedAccent(hex, isDark);
  return isDark
    ? darkenForBackground(hexToHsl(normalized))
    : lightenForBackground(hexToHsl(normalized));
};

const LYRIC_BACKGROUND_COLOR_SETTLE_MS = 180;

export function useLyricBackground(
  coverUrl: ComputedRef<string | undefined>,
  isDark: ComputedRef<boolean>,
) {
  // 保留封面原始取色，最终背景色按外观模式派生，切换深浅色时无需重新解码封面
  const rawColor = ref('');
  const backgroundColor = computed(() =>
    rawColor.value ? resolveCoverBackgroundColor(rawColor.value, isDark.value) : '',
  );
  let requestSeq = 0;
  let abortController: AbortController | null = null;

  const refresh = async (url: string | undefined) => {
    const seq = ++requestSeq;
    abortController?.abort();
    const controller = new AbortController();
    abortController = controller;
    const urls = resolveCoverColorUrls(url, 300, { scope: 'lyric-background' });
    if (urls.length === 0) {
      if (abortController === controller) abortController = null;
      rawColor.value = '';
      return;
    }

    const shouldExtract = await waitForAbortableDelay(
      LYRIC_BACKGROUND_COLOR_SETTLE_MS,
      controller.signal,
    );
    if (!shouldExtract || seq !== requestSeq) return;

    let color: string | null = null;
    for (const candidateUrl of urls) {
      color = await extractDominantColor(candidateUrl, { signal: controller.signal });
      if (seq !== requestSeq || controller.signal.aborted) return;
      if (color) break;
    }

    if (abortController === controller) abortController = null;
    if (!color) {
      rawColor.value = '';
      return;
    }

    rawColor.value = color;
  };

  watch([coverUrl, coverFallbackRevision], ([url]) => void refresh(url), { immediate: true });
  onScopeDispose(() => {
    requestSeq += 1;
    abortController?.abort();
    abortController = null;
  });

  return {
    backgroundColor,
  };
}
