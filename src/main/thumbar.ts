import { BrowserWindow, nativeImage, ipcMain } from 'electron';
import { deflateSync } from 'zlib';
import log from './logger';
import type { NowPlayingPlaybackPayload } from '../shared/nowPlaying';

let currentIsPlaying = false;
let currentIsFavorite = false;
let hasCurrentTrack = false;
let targetWindow: BrowserWindow | null = null;
let thumbarSetup = false;

// --- RGBA PNG Generator (支持抗锯齿) ---

function createRgbaPng(
  width: number,
  height: number,
  drawPixels: (
    setPixel: (x: number, y: number, r: number, g: number, b: number, a: number) => void,
  ) => void,
): Buffer {
  const pixels = new Uint8Array(width * height * 4);

  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    // Alpha blending over black background
    const alpha = a / 255;
    pixels[idx] = Math.round(r * alpha);
    pixels[idx + 1] = Math.round(g * alpha);
    pixels[idx + 2] = Math.round(b * alpha);
    pixels[idx + 3] = a;
  };

  drawPixels(setPixel);

  // Build raw image data with None filter
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    for (let x = 0; x < width * 4; x++) {
      rawData[y * (1 + width * 4) + 1 + x] = pixels[y * width * 4 + x];
    }
  }

  const compressed = deflateSync(rawData);

  const crc32Table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crc32Table[n] = c;
  }

  const crc32 = (data: Buffer): number => {
    let crc = -1;
    for (let i = 0; i < data.length; i++) {
      crc = crc32Table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ -1) >>> 0;
  };

  const writeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuffer = Buffer.from(type, 'ascii');
    const chunk = Buffer.concat([typeBuffer, data]);
    const crcVal = crc32(chunk);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal);
    return Buffer.concat([len, chunk, crcBuf]);
  };

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    signature,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', compressed),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- 图标绘制（64x64 超采样 + 抗锯齿） ---

const ICON_SIZE = 64;
const ICON_R = 43;
const ICON_G = 90;
const ICON_B = 58;

/** 三角形 SDF（基于重心坐标的有符号距离） */
function triangleSdf(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  const ex0 = bx - ax,
    ey0 = by - ay;
  const ex1 = cx - bx,
    ey1 = cy - by;
  const ex2 = ax - cx,
    ey2 = ay - cy;
  const d0 = ex0 * (y - ay) - ey0 * (x - ax);
  const d1 = ex1 * (y - by) - ey1 * (x - bx);
  const d2 = ex2 * (y - cy) - ey2 * (x - cx);
  const inside = (d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0);
  if (!inside) return Math.max(Math.abs(d0), Math.abs(d1), Math.abs(d2));
  return -Math.min(Math.abs(d0), Math.abs(d1), Math.abs(d2));
}

/** 矩形 SDF */
function rectSdf(
  x: number,
  y: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): number {
  const dx = Math.max(left - x, 0, x - right);
  const dy = Math.max(top - y, 0, y - bottom);
  const outsideDist = Math.sqrt(dx * dx + dy * dy);
  const insideDist = Math.min(Math.max(left - x, x - right, 0), Math.max(top - y, y - bottom, 0));
  const d = outsideDist + insideDist;
  return dx > 0 || dy > 0 ? d : -d;
}

/** SDF → alpha（平滑抗锯齿过渡） */
function sdfToAlpha(sdf: number, halfWidth: number): number {
  const aa = 1.2;
  if (sdf < -halfWidth) return 255;
  if (sdf > halfWidth) return 0;
  const t = (sdf + halfWidth) / (2 * halfWidth);
  const edge = 0.5 - aa / (2 * halfWidth);
  return Math.round(255 * Math.max(0, Math.min(1, 1 - (t - edge) / aa)));
}

// Previous: |◀◀
function makePrevIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const barL = 10,
      barR = 16,
      barT = 14,
      barB = 50;
    const t1 = { ax: 48, ay: 14, bx: 48, by: 50, cx: 26, cy: 32 };
    const t2 = { ax: 60, ay: 14, bx: 60, by: 50, cx: 38, cy: 32 };
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d = Math.min(
          rectSdf(x, y, barL, barT, barR, barB),
          triangleSdf(x, y, t1.ax, t1.ay, t1.bx, t1.by, t1.cx, t1.cy),
          triangleSdf(x, y, t2.ax, t2.ay, t2.bx, t2.by, t2.cx, t2.cy),
        );
        const alpha = sdfToAlpha(d, 2.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Play: ▶
function makePlayIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const ax = 18;
    const ay = 10;
    const bx = 18;
    const by = 54;
    const cx = 50;
    const cy = 32;
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d = triangleSdf(x, y, ax, ay, bx, by, cx, cy);
        const alpha = sdfToAlpha(d, 2.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Pause: ⏸
function makePauseIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const gap = 8;
    const bw = 12;
    const bh = 40;
    const top = (ICON_SIZE - bh) / 2;
    const bot = top + bh;
    const l1 = (ICON_SIZE - gap) / 2 - bw;
    const r1 = l1 + bw;
    const l2 = (ICON_SIZE + gap) / 2;
    const r2 = l2 + bw;
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d = Math.min(rectSdf(x, y, l1, top, r1, bot), rectSdf(x, y, l2, top, r2, bot));
        const alpha = sdfToAlpha(d, 2.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Next: ▶▶|
function makeNextIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const barL = 48,
      barR = 54,
      barT = 14,
      barB = 50;
    const t1 = { ax: 4, ay: 14, bx: 4, by: 50, cx: 26, cy: 32 };
    const t2 = { ax: 18, ay: 14, bx: 18, by: 50, cx: 40, cy: 32 };
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d = Math.min(
          rectSdf(x, y, barL, barT, barR, barB),
          triangleSdf(x, y, t1.ax, t1.ay, t1.bx, t1.by, t1.cx, t1.cy),
          triangleSdf(x, y, t2.ax, t2.ay, t2.bx, t2.by, t2.cx, t2.cy),
        );
        const alpha = sdfToAlpha(d, 2.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

function makeHeartIcon(filled: boolean): Buffer {
  const inside = (x: number, y: number, scale = 1) => {
    const px = (x - (ICON_SIZE - 1) / 2) / (20 * scale);
    const py = ((ICON_SIZE - 1) / 2 - y) / (20 * scale);
    const sum = px * px + py * py - 1;
    return sum * sum * sum - px * px * py * py * py <= 0;
  };
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        if (inside(x, y) && (filled || !inside(x, y, 0.76))) {
          setPixel(x, y, filled ? 232 : ICON_R, filled ? 43 : ICON_G, filled ? 91 : ICON_B, 255);
        }
      }
    }
  });
}

let cachedIcons: {
  play: Electron.NativeImage;
  pause: Electron.NativeImage;
  prev: Electron.NativeImage;
  next: Electron.NativeImage;
  heart: Electron.NativeImage;
  heartFilled: Electron.NativeImage;
} | null = null;

function getIcons() {
  if (cachedIcons) return cachedIcons;
  cachedIcons = {
    play: nativeImage.createFromBuffer(makePlayIcon()),
    pause: nativeImage.createFromBuffer(makePauseIcon()),
    prev: nativeImage.createFromBuffer(makePrevIcon()),
    next: nativeImage.createFromBuffer(makeNextIcon()),
    heart: nativeImage.createFromBuffer(makeHeartIcon(false)),
    heartFilled: nativeImage.createFromBuffer(makeHeartIcon(true)),
  };
  return cachedIcons;
}

function buildThumbarButtons(win: BrowserWindow): Electron.ThumbarButton[] {
  const icons = getIcons();
  return [
    {
      tooltip: '上一曲',
      icon: icons.prev,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Previous track clicked');
        win.webContents.send('media-control:event', { type: 'PreviousSong' });
      },
    },
    {
      tooltip: currentIsPlaying ? '暂停' : '播放',
      icon: currentIsPlaying ? icons.pause : icons.play,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Play/Pause clicked');
        win.webContents.send('media-control:event', {
          type: currentIsPlaying ? 'Pause' : 'Play',
        });
      },
    },
    {
      tooltip: '下一曲',
      icon: icons.next,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        log.debug('[Thumbar] Next track clicked');
        win.webContents.send('media-control:event', { type: 'NextSong' });
      },
    },
    {
      tooltip: currentIsFavorite ? '取消收藏' : '收藏',
      icon: currentIsFavorite ? icons.heartFilled : icons.heart,
      flags: hasCurrentTrack ? [] : ['disabled'],
      click: () => {
        if (hasCurrentTrack && !win.isDestroyed()) {
          win.webContents.send('now-playing:command', 'toggleFavorite');
        }
      },
    },
  ];
}

function applyThumbarButtons(win: BrowserWindow) {
  if (win.isDestroyed()) return false;
  const result = win.setThumbarButtons(buildThumbarButtons(win));
  log.info('[Thumbar] setThumbarButtons result:', result);
  return result;
}

export function setupThumbarButtons(win: BrowserWindow) {
  if (process.platform !== 'win32') return;
  if (targetWindow !== win) {
    targetWindow = win;
    // Rebind window lifecycle on recreation, without adding duplicate IPC listeners.
    win.on('show', () => applyThumbarButtons(win));
    win.once('closed', () => {
      if (targetWindow === win) targetWindow = null;
    });
  }
  if (!thumbarSetup) {
    thumbarSetup = true;

    ipcMain.on('thumbar:update-play-state', (event, isPlaying: boolean) => {
      const win = targetWindow;
      if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return;
      if (typeof isPlaying !== 'boolean' || !hasCurrentTrack) return;
      if (currentIsPlaying === isPlaying) return;
      currentIsPlaying = isPlaying;
      if (!win.isDestroyed()) {
        applyThumbarButtons(win);
      }
    });
  }

  applyThumbarButtons(win);
  log.info('[Thumbar] Thumbnail toolbar buttons initialized');
}

/** Reuse the validated v2.3.1 playback snapshot; no second renderer state channel. */
export function updateThumbarPlayback(playback: NowPlayingPlaybackPayload | null): void {
  if (process.platform !== 'win32') return;
  const hasTrack = Boolean(playback?.trackId);
  const playing = hasTrack && Boolean(playback?.isPlaying);
  const favorite = hasTrack && Boolean(playback?.isFavorite);
  if (
    hasCurrentTrack === hasTrack &&
    currentIsPlaying === playing &&
    currentIsFavorite === favorite
  )
    return;
  hasCurrentTrack = hasTrack;
  currentIsPlaying = playing;
  currentIsFavorite = favorite;
  if (targetWindow) applyThumbarButtons(targetWindow);
}
