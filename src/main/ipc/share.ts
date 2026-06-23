import { clipboard } from 'electron';
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

      const image = await event.sender.capturePage(captureRect);
      if (image.isEmpty()) return false;

      clipboard.writeImage(image);
      return true;
    },
  );
};
