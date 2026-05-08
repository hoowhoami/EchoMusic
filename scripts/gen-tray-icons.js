#!/usr/bin/env node
// 生成托盘图标：将源图标（黑色圆角方块 + Echo 字形镂空）
// 转换为"品牌蓝色方块 + 白色字形"的统一样式。
// 输入：build/icons/tray_icon_source.png（源图，alpha 通道标识图形形状）
// 输出：
//   - build/icons/linux_tray_icon.png（64x64 PNG）
//   - build/icons/win_tray_icon.ico（多尺寸 ICO：16/20/24/32/48/64/128/256）

const fs = require('fs');
const path = require('path');
const { PNG } = require(path.join(__dirname, '../server/node_modules/pngjs'));

const BRAND_R = 0x00;
const BRAND_G = 0x71;
const BRAND_B = 0xe3;

const SRC_PNG = path.join(__dirname, '../build/icons/tray_icon_source.png');
const OUT_LINUX_PNG = path.join(__dirname, '../build/icons/linux_tray_icon.png');
const OUT_WIN_ICO = path.join(__dirname, '../build/icons/win_tray_icon.ico');

/** 读取 PNG */
function readPng(filePath) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

/**
 * 核心染色逻辑：
 * 原图结构是"黑色圆角方块 + Echo 字形镂空（透明）"。方块实体区域的像素 alpha 接近 255，
 * 字形镂空区域的像素 alpha 接近 0，字形边缘是两者之间的渐变（抗锯齿）。
 *
 * 目标：将方块实体染成品牌蓝、字形镂空染成白色，同时**保留字形边缘的抗锯齿过渡**。
 *
 * 做法：
 * 1. 逐行扫描确定方块填充范围（用较低阈值识别，包含边缘半透明像素）
 * 2. 范围内：将原 alpha 归一化为 t ∈ [0, 1]，t 越接近 1 代表越靠近方块实体、越接近 0 代表越靠近字形
 *    颜色 = 白色 * (1 - t) + 品牌蓝 * t；alpha = 255（范围内全不透明，保证没有背景透出来）
 * 3. 范围外（圆角方块的外部抗锯齿边缘）：品牌蓝，保留原 alpha 以实现平滑圆角
 */
function paintBlock(png) {
  const out = new PNG({ width: png.width, height: png.height });
  const W = png.width;
  const H = png.height;
  // 行填充范围识别阈值：用较高阈值（只识别"方块实心"像素），
  // 让圆角弧形边缘的半透明抗锯齿像素走"范围外"分支染成纯品牌蓝，
  // 避免被混入白色产生边角毛边。
  const RANGE_ALPHA = 200;

  for (let y = 0; y < H; y++) {
    // 找这一行方块的水平范围（第一个和最后一个 alpha > 0 的像素）
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < W; x++) {
      const a = png.data[(y * W + x) * 4 + 3];
      if (a > RANGE_ALPHA) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }

    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4;
      const a = png.data[idx + 3];

      if (minX !== -1 && x >= minX && x <= maxX) {
        // 在方块范围内：根据原 alpha 在白色（字形）和品牌蓝（方块）之间混合
        // 注意：字形镂空处 alpha=0，应该视为"纯字形"→ 白色
        const t = a / 255; // 0=字形镂空, 1=方块实体
        out.data[idx] = Math.round(255 * (1 - t) + BRAND_R * t);
        out.data[idx + 1] = Math.round(255 * (1 - t) + BRAND_G * t);
        out.data[idx + 2] = Math.round(255 * (1 - t) + BRAND_B * t);
        out.data[idx + 3] = 255;
      } else if (a === 0) {
        // 方块范围外且完全透明：保持透明
        out.data[idx + 3] = 0;
      } else {
        // 方块范围外但有 alpha（圆角外部抗锯齿）：品牌蓝 + 原 alpha
        out.data[idx] = BRAND_R;
        out.data[idx + 1] = BRAND_G;
        out.data[idx + 2] = BRAND_B;
        out.data[idx + 3] = a;
      }
    }
  }
  return out;
}

/**
 * Box filter 下采样：对每个目标像素取源图对应区域的面积加权平均。
 * 相比双线性，大比例缩小时保留更多细节，边缘更锐利。
 * 使用 premultiplied alpha 避免透明边缘产生彩色晕边。
 */
function resizeBox(png, targetSize) {
  if (png.width === targetSize && png.height === targetSize) return png;

  const out = new PNG({ width: targetSize, height: targetSize });
  const scaleX = png.width / targetSize;
  const scaleY = png.height / targetSize;

  for (let y = 0; y < targetSize; y++) {
    const srcY0 = y * scaleY;
    const srcY1 = (y + 1) * scaleY;
    const y0 = Math.floor(srcY0);
    const y1 = Math.min(png.height - 1, Math.ceil(srcY1) - 1);

    for (let x = 0; x < targetSize; x++) {
      const srcX0 = x * scaleX;
      const srcX1 = (x + 1) * scaleX;
      const x0 = Math.floor(srcX0);
      const x1 = Math.min(png.width - 1, Math.ceil(srcX1) - 1);

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      let totalWeight = 0;

      for (let sy = y0; sy <= y1; sy++) {
        const wy = Math.min(sy + 1, srcY1) - Math.max(sy, srcY0);
        for (let sx = x0; sx <= x1; sx++) {
          const wx = Math.min(sx + 1, srcX1) - Math.max(sx, srcX0);
          const w = wx * wy;
          const idx = (sy * png.width + sx) * 4;
          const a = png.data[idx + 3];
          sumR += png.data[idx] * a * w;
          sumG += png.data[idx + 1] * a * w;
          sumB += png.data[idx + 2] * a * w;
          sumA += a * w;
          totalWeight += w;
        }
      }

      const dstIdx = (y * targetSize + x) * 4;
      if (sumA > 0) {
        out.data[dstIdx] = Math.round(sumR / sumA);
        out.data[dstIdx + 1] = Math.round(sumG / sumA);
        out.data[dstIdx + 2] = Math.round(sumB / sumA);
        out.data[dstIdx + 3] = Math.round(sumA / totalWeight);
      } else {
        out.data[dstIdx + 3] = 0;
      }
    }
  }
  return out;
}

/** 构造多尺寸 ICO 文件 */
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + 16 * count;
  let dataSize = 0;
  for (const p of pngBuffers) dataSize += p.buffer.length;

  const ico = Buffer.alloc(headerSize + dataSize);

  // ICONDIR
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(count, 4);

  let offset = headerSize;
  for (let i = 0; i < count; i++) {
    const { size, buffer } = pngBuffers[i];
    const entryOff = 6 + 16 * i;
    ico.writeUInt8(size >= 256 ? 0 : size, entryOff + 0);
    ico.writeUInt8(size >= 256 ? 0 : size, entryOff + 1);
    ico.writeUInt8(0, entryOff + 2);
    ico.writeUInt8(0, entryOff + 3);
    ico.writeUInt16LE(1, entryOff + 4);
    ico.writeUInt16LE(32, entryOff + 6);
    ico.writeUInt32LE(buffer.length, entryOff + 8);
    ico.writeUInt32LE(offset, entryOff + 12);

    buffer.copy(ico, offset);
    offset += buffer.length;
  }

  return ico;
}

function main() {
  if (!fs.existsSync(SRC_PNG)) {
    console.error(`Source PNG not found: ${SRC_PNG}`);
    process.exit(1);
  }

  console.log(`Reading source: ${SRC_PNG}`);
  const src = readPng(SRC_PNG);
  console.log(`  Size: ${src.width}x${src.height}`);

  // 1. 染色：黑底 + 镂空字 → 蓝底 + 白字
  const painted = paintBlock(src);

  // 2. Linux: 64x64 PNG
  const linuxPng = resizeBox(painted, 64);
  fs.writeFileSync(OUT_LINUX_PNG, PNG.sync.write(linuxPng));
  console.log(`Wrote Linux icon: ${OUT_LINUX_PNG} (64x64)`);

  // 3. Windows: 多尺寸 ICO
  const winSizes = [16, 20, 24, 32, 48, 64, 128, 256];
  const pngBuffers = winSizes.map((size) => ({
    size,
    buffer: PNG.sync.write(resizeBox(painted, size)),
  }));
  fs.writeFileSync(OUT_WIN_ICO, buildIco(pngBuffers));
  console.log(`Wrote Windows ICO: ${OUT_WIN_ICO} (sizes: ${winSizes.join(', ')})`);
}

main();
