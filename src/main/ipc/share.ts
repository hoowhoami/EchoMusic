import { clipboard, screen, BrowserWindow } from 'electron';
import type { ShareCaptureRect } from '../../shared/share';
import { ipcRegistry } from './registry';

const toFiniteNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeCaptureRect = (rect: ShareCaptureRect | undefined) => {
  if (!rect || typeof rect !== 'object') return null;

  const x = toFiniteNumber(rect.x);
  const y = toFiniteNumber(rect.y);
  const width = toFiniteNumber(rect.width);
  const height = toFiniteNumber(rect.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;

  return {
    x: Math.max(0, Math.floor(x)),
    y: Math.max(0, Math.floor(y)),
    width: Math.min(4096, Math.ceil(width)),
    height: Math.min(4096, Math.ceil(height)),
  };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const registerShareHandlers = () => {
  ipcRegistry.registerHandler('share:copy', (_event, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });
  ipcRegistry.registerHandler('share:read-clipboard', () => clipboard.readText());
  ipcRegistry.registerHandler(
    'share:capture-rect-to-clipboard',
    async (event, rect: ShareCaptureRect | undefined) => {
      const captureRect = normalizeCaptureRect(rect);
      if (!captureRect || event.sender.isDestroyed()) return false;

      // capturePage(rect) 的 rect 裁剪在混合 DPI / 窗口跨屏等环境下坐标语义不稳定
      // （听歌统计分享曾因此错位截到页面其他区域）；这里改为整页截图后，
      // 由自己按「CSS 坐标 × zoomFactor × 屏幕缩放」换算物理像素再裁剪。
      const image = await event.sender.capturePage();
      if (image.isEmpty()) return false;

      const win = BrowserWindow.fromWebContents(event.sender);
      const scaleFactor = win ? screen.getDisplayMatching(win.getBounds()).scaleFactor : 1;
      const scale = event.sender.getZoomFactor() * scaleFactor;
      const size = image.getSize();
      const x = clamp(Math.round(captureRect.x * scale), 0, size.width);
      const y = clamp(Math.round(captureRect.y * scale), 0, size.height);
      const width = clamp(Math.round(captureRect.width * scale), 0, size.width - x);
      const height = clamp(Math.round(captureRect.height * scale), 0, size.height - y);
      if (width <= 0 || height <= 0) return false;

      clipboard.writeImage(image.crop({ x, y, width, height }));
      return true;
    },
  );
};
