// 主题色工具：提取、归一化、派生 CSS 变量

// 默认主题色（与 style.css 默认值保持一致）
export const DEFAULT_ACCENT = '#0071e3';

// 预设主题色
export interface AccentPreset {
  id: string;
  name: string;
  color: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'default', name: '默认蓝', color: '#0071e3' },
  { id: 'crimson', name: '赤焰红', color: '#ef4444' },
  { id: 'rose', name: '玫瑰粉', color: '#ec4899' },
  { id: 'purple', name: '暮色紫', color: '#8b5cf6' },
  { id: 'indigo', name: '靛青', color: '#6366f1' },
  { id: 'sky', name: '天蓝', color: '#0ea5e9' },
  { id: 'teal', name: '薄荷', color: '#14b8a6' },
  { id: 'forest', name: '森绿', color: '#22c55e' },
  { id: 'amber', name: '琥珀', color: '#f59e0b' },
  { id: 'orange', name: '落日橙', color: '#f97316' },
];

// ─────────────── 颜色空间转换 ───────────────

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const clamp255 = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const raw = String(hex ?? '').trim();
  if (!raw) return null;
  let value = raw.startsWith('#') ? raw.slice(1) : raw;
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

export const rgbToHex = (r: number, g: number, b: number): string => {
  const toHex = (v: number) => clamp255(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

interface Hsl {
  h: number; // [0, 360)
  s: number; // [0, 1]
  l: number; // [0, 1]
}

export const rgbToHsl = (r: number, g: number, b: number): Hsl => {
  const nr = r / 255;
  const ng = g / 255;
  const nb = b / 255;
  const max = Math.max(nr, ng, nb);
  const min = Math.min(nr, ng, nb);
  const delta = max - min;
  let h = 0;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  if (delta !== 0) {
    if (max === nr) h = ((ng - nb) / delta) % 6;
    else if (max === ng) h = (nb - nr) / delta + 2;
    else h = (nr - ng) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: clamp01(s), l: clamp01(l) };
};

export const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  const sat = clamp01(s);
  const lit = clamp01(l);
  const c = (1 - Math.abs(2 * lit - 1)) * sat;
  const hue = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lit - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: clamp255((r + m) * 255),
    g: clamp255((g + m) * 255),
    b: clamp255((b + m) * 255),
  };
};

// ─────────────── 归一化 ───────────────

// 将颜色按深/浅色模式调整到合适的视觉区间
// 浅色模式下限制饱和度和亮度，避免过亮刺眼；深色模式下提亮避免糊掉
export const normalizeAccent = (hex: string, isDark: boolean): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return DEFAULT_ACCENT;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // 近乎灰度的颜色，回落到默认主题色
  if (s < 0.08) return DEFAULT_ACCENT;

  let nextS = s;
  let nextL = l;

  if (isDark) {
    // 深色模式：S ∈ [0.45, 0.85]，L ∈ [0.55, 0.72]
    nextS = Math.min(0.85, Math.max(0.45, s));
    nextL = Math.min(0.72, Math.max(0.55, l));
  } else {
    // 浅色模式：S ∈ [0.55, 0.9]，L ∈ [0.42, 0.55]
    nextS = Math.min(0.9, Math.max(0.55, s));
    nextL = Math.min(0.55, Math.max(0.42, l));
  }

  const { r, g, b } = hslToRgb(h, nextS, nextL);
  return rgbToHex(r, g, b);
};

// ─────────────── 封面取色 ───────────────

// 从图片 URL 中提取主色，失败时返回 null
export const extractDominantColor = (url: string): Promise<string | null> => {
  return new Promise((resolve) => {
    if (!url) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const timeoutId = window.setTimeout(() => {
      if (done) return;
      done = true;
      resolve(null);
    }, 5000);

    img.onload = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timeoutId);
      try {
        const size = 64;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;

        // 按色相分桶（每 20° 一桶，共 18 个桶）
        const BUCKET_COUNT = 18;
        const buckets = Array.from({ length: BUCKET_COUNT }, () => ({
          weight: 0,
          r: 0,
          g: 0,
          b: 0,
        }));
        let totalSat = 0;
        let sampleCount = 0;

        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          if (a < 200) continue;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const hsl = rgbToHsl(r, g, b);

          // 过滤近白、近黑、灰度像素
          if (hsl.l < 0.15 || hsl.l > 0.92) continue;
          if (hsl.s < 0.18) continue;

          sampleCount += 1;
          totalSat += hsl.s;

          // 评分：饱和度越高、亮度越接近 0.5 分数越高
          const lScore = 1 - Math.abs(hsl.l - 0.5) * 1.2;
          const score = hsl.s * Math.max(0.15, lScore);

          const bucketIdx = Math.min(BUCKET_COUNT - 1, Math.floor(hsl.h / (360 / BUCKET_COUNT)));
          const bucket = buckets[bucketIdx];
          bucket.weight += score;
          bucket.r += r * score;
          bucket.g += g * score;
          bucket.b += b * score;
        }

        // 没采到像素，或图片整体太灰，放弃
        if (sampleCount === 0 || totalSat / Math.max(1, sampleCount) < 0.15) {
          resolve(null);
          return;
        }

        // 找出权重最高的桶
        let bestIdx = -1;
        let bestWeight = 0;
        for (let i = 0; i < buckets.length; i += 1) {
          if (buckets[i].weight > bestWeight) {
            bestWeight = buckets[i].weight;
            bestIdx = i;
          }
        }
        if (bestIdx < 0 || bestWeight <= 0) {
          resolve(null);
          return;
        }

        const best = buckets[bestIdx];
        const r = best.r / best.weight;
        const g = best.g / best.weight;
        const b = best.b / best.weight;
        resolve(rgbToHex(r, g, b));
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => {
      if (done) return;
      done = true;
      window.clearTimeout(timeoutId);
      resolve(null);
    };

    img.src = url;
  });
};

// ─────────────── 写入 CSS 变量 ───────────────

// 向 :root 注入主题色变量
// 写入两套：主变量 --color-primary-*（全局生效）和 *-root 副本（给 accent-scoped 的播放栏覆盖用）
export const applyAccentToRoot = (hex: string, isDark: boolean) => {
  const normalized = normalizeAccent(hex, isDark);
  const rgb = hexToRgb(normalized);
  if (!rgb) return;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  // hover：浅色模式下亮度略降，深色模式下亮度略升，增强点按反馈
  const hoverL = isDark ? Math.min(0.8, l + 0.06) : Math.max(0.36, l - 0.04);
  const hoverRgb = hslToRgb(h, s, hoverL);
  const hoverHex = rgbToHex(hoverRgb.r, hoverRgb.g, hoverRgb.b);
  const lightValue = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.15)`;
  const darkValue = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.36)`;
  const rgbValue = `${rgb.r}, ${rgb.g}, ${rgb.b}`;

  const root = document.documentElement;
  root.style.setProperty('--color-primary', normalized);
  root.style.setProperty('--color-primary-hover', hoverHex);
  root.style.setProperty('--color-primary-light', lightValue);
  root.style.setProperty('--color-primary-dark', darkValue);
  root.style.setProperty('--color-primary-rgb', rgbValue);

  // 副本：即使 .main-layout 把 --color-primary 覆盖为品牌蓝，播放栏仍可取到真主题色
  root.style.setProperty('--color-primary-root', normalized);
  root.style.setProperty('--color-primary-hover-root', hoverHex);
  root.style.setProperty('--color-primary-light-root', lightValue);
  root.style.setProperty('--color-primary-dark-root', darkValue);
  root.style.setProperty('--color-primary-rgb-root', rgbValue);
};

// 获取归一化后的主题色 hex（给外部使用，如歌词字色同步）
export const getNormalizedAccent = (hex: string, isDark: boolean): string => {
  return normalizeAccent(hex, isDark);
};
