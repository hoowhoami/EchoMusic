import { BrowserWindow, nativeImage, ipcMain } from 'electron';
import { deflateSync } from 'zlib';
import log from './logger';

let currentIsPlaying = false;
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

// --- 图标绘制（32x32 高分辨率 + 抗锯齿） ---

const ICON_SIZE = 32;
// 深灰色图标，匹配参考样式
const ICON_R = 51;
const ICON_G = 51;
const ICON_B = 54;

/** 点到三角形边的有符号距离 */
function edgeDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  return (bx - ax) * (y - ay) - (by - ay) * (x - ax);
}

/** 判断点在三角形内外，返回有符号面积 */
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
  const d0 = edgeDist(x, y, ax, ay, bx, by);
  const d1 = edgeDist(x, y, bx, by, cx, cy);
  const d2 = edgeDist(x, y, cx, cy, ax, ay);
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

function sdfToAlpha(sdf: number, radius: number): number {
  const aa = 0.8;
  if (sdf < -radius) return 255;
  if (sdf > radius) return 0;
  const t = (sdf + radius) / (2 * radius);
  return Math.round(255 * Math.max(0, Math.min(1, 1 - (t - 0.5 + aa / 2 / radius) / aa)));
}

// Previous: |◀◀ (竖线 + 两个向左三角形)
function makePrevIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const barLeft = 5;
    const barRight = 8;
    const barTop = 7;
    const barBottom = 25;
    // 两个向左的三角形（底边在右，顶点在左）
    const tri1 = { ax: 24, ay: 7, bx: 24, by: 25, cx: 13, cy: 16 };
    const tri2 = { ax: 30, ay: 7, bx: 30, by: 25, cx: 19, cy: 16 };
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const dBar = rectSdf(x, y, barLeft, barTop, barRight, barBottom);
        const dTri1 = triangleSdf(x, y, tri1.ax, tri1.ay, tri1.bx, tri1.by, tri1.cx, tri1.cy);
        const dTri2 = triangleSdf(x, y, tri2.ax, tri2.ay, tri2.bx, tri2.by, tri2.cx, tri2.cy);
        const d = Math.min(dBar, dTri1, dTri2);
        const alpha = sdfToAlpha(d, 1.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Play: ▶ (单个向右三角形)
function makePlayIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const ax = 9;
    const ay = 5;
    const bx = 9;
    const by = 27;
    const cx = 25;
    const cy = 16;
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const sdf = triangleSdf(x, y, ax, ay, bx, by, cx, cy);
        const alpha = sdfToAlpha(sdf, 1.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Pause: ⏸ (两个竖条)
function makePauseIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const gap = 4;
    const barWidth = 6;
    const barHeight = 20;
    const top = (ICON_SIZE - barHeight) / 2;
    const bottom = top + barHeight;
    const left1 = (ICON_SIZE - gap) / 2 - barWidth;
    const right1 = left1 + barWidth;
    const left2 = (ICON_SIZE + gap) / 2;
    const right2 = left2 + barWidth;
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const d1 = rectSdf(x, y, left1, top, right1, bottom);
        const d2 = rectSdf(x, y, left2, top, right2, bottom);
        const d = Math.min(d1, d2);
        const alpha = sdfToAlpha(d, 1.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

// Next: ▶▶| (两个向右三角形 + 竖线)
function makeNextIcon(): Buffer {
  return createRgbaPng(ICON_SIZE, ICON_SIZE, (setPixel) => {
    const barLeft = 24;
    const barRight = 27;
    const barTop = 7;
    const barBottom = 25;
    // 两个向右的三角形
    const tri1 = { ax: 2, ay: 7, bx: 2, by: 25, cx: 13, cy: 16 };
    const tri2 = { ax: 9, ay: 7, bx: 9, by: 25, cx: 20, cy: 16 };
    for (let y = 0; y < ICON_SIZE; y++) {
      for (let x = 0; x < ICON_SIZE; x++) {
        const dBar = rectSdf(x, y, barLeft, barTop, barRight, barBottom);
        const dTri1 = triangleSdf(x, y, tri1.ax, tri1.ay, tri1.bx, tri1.by, tri1.cx, tri1.cy);
        const dTri2 = triangleSdf(x, y, tri2.ax, tri2.ay, tri2.bx, tri2.by, tri2.cx, tri2.cy);
        const d = Math.min(dBar, dTri1, dTri2);
        const alpha = sdfToAlpha(d, 1.0);
        if (alpha > 0) setPixel(x, y, ICON_R, ICON_G, ICON_B, alpha);
      }
    }
  });
}

let cachedIcons: {
  play: Electron.NativeImage;
  pause: Electron.NativeImage;
  prev: Electron.NativeImage;
  next: Electron.NativeImage;
} | null = null;

function getIcons() {
  if (cachedIcons) return cachedIcons;
  cachedIcons = {
    play: nativeImage.createFromBuffer(makePlayIcon()),
    pause: nativeImage.createFromBuffer(makePauseIcon()),
    prev: nativeImage.createFromBuffer(makePrevIcon()),
    next: nativeImage.createFromBuffer(makeNextIcon()),
  };
  return cachedIcons;
}

function buildThumbarButtons(win: BrowserWindow): Electron.ThumbarButton[] {
  const icons = getIcons();
  return [
    {
      tooltip: '上一曲',
      icon: icons.prev,
      click: () => {
        log.debug('[Thumbar] Previous track clicked');
        win.webContents.send('media-control:event', { type: 'PreviousSong' });
      },
    },
    {
      tooltip: currentIsPlaying ? '暂停' : '播放',
      icon: currentIsPlaying ? icons.pause : icons.play,
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
      click: () => {
        log.debug('[Thumbar] Next track clicked');
        win.webContents.send('media-control:event', { type: 'NextSong' });
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
  if (!thumbarSetup) {
    thumbarSetup = true;

    ipcMain.on('thumbar:update-play-state', (_event, isPlaying: boolean) => {
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
