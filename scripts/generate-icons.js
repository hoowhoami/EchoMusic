import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconDir = path.join(__dirname, '../app/icons');
const svgPath = path.join(iconDir, 'icon.svg');

// PNG 尺寸
const sizes = [16, 32, 64, 128, 256, 512, 1024];

console.log('生成 PNG 图标...');

// 读取 SVG
const svgBuffer = fs.readFileSync(svgPath);

// 生成普通 PNG
for (const size of sizes) {
  await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toFile(path.join(iconDir, `${size}x${size}.png`));
  console.log(`✓ ${size}x${size}.png`);
}

// 生成 macOS 专用 PNG（带 10% 透明边距）
console.log('\n生成 macOS 图标（带透明边距）...');
const macSizes = [16, 32, 64, 128, 256, 512, 1024];
for (const size of macSizes) {
  const padding = Math.floor(size * 0.1);
  const innerSize = size - padding * 2;

  await sharp(svgBuffer)
    .resize(innerSize, innerSize)
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(path.join(iconDir, `icon.iconset/icon_${size}x${size}.png`));

  if (size <= 512) {
    await sharp(svgBuffer)
      .resize(innerSize * 2, innerSize * 2)
      .extend({
        top: padding * 2,
        bottom: padding * 2,
        left: padding * 2,
        right: padding * 2,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toFile(path.join(iconDir, `icon.iconset/icon_${size}x${size}@2x.png`));
  }
  console.log(`✓ icon_${size}x${size}.png`);
}

// 生成 Windows ICO
console.log('\n生成 Windows ICO...');
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoBuffers = [];
for (const size of icoSizes) {
  const buf = await sharp(svgBuffer)
    .resize(size, size)
    .png()
    .toBuffer();
  icoBuffers.push(buf);
}
const ico = await pngToIco(icoBuffers);
fs.writeFileSync(path.join(iconDir, 'icon.ico'), ico);
console.log('✓ icon.ico');

console.log('\n✓ 所有图标生成完成！');
console.log('\n请运行以下命令生成 macOS .icns 文件：');
console.log(`iconutil -c icns "${iconDir}/icon.iconset" -o "${iconDir}/icon.icns"`);
