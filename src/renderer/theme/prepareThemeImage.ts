import {
  MAX_THEME_IMAGE_BYTES,
  MAX_THEME_IMAGE_EDGE,
  MAX_THEME_IMAGE_PIXELS,
} from '../../shared/themeImage';

/** Decode asynchronously with Chromium, including WebP and JPEG EXIF orientation. */
export async function prepareThemeImage(file: File): Promise<Uint8Array> {
  if (!file.size || file.size > MAX_THEME_IMAGE_BYTES) throw new Error('请选择不超过 20 MB 的图片');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => header[i] === byte);
  const jpg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  const webp =
    String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...header.slice(8, 12)) === 'WEBP';
  if (!png && !jpg && !webp) throw new Error('仅支持 JPG、PNG、WebP 图片');

  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error('图片无法解码，文件可能已损坏，请重新导出为 JPG、PNG 或 WebP');
  }
  const canvas = document.createElement('canvas');
  try {
    const { width, height } = image;
    if (!width || !height) throw new Error('图片尺寸无效，请重新选择图片');
    if (width * height > MAX_THEME_IMAGE_PIXELS)
      throw new Error(`图片分辨率 ${width} × ${height} 过大，请先缩小到 1 亿像素以内`);
    const ratio = Math.min(1, MAX_THEME_IMAGE_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图片处理失败，请重试');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('图片处理失败，请重新选择图片'))),
        'image/png',
      ),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    image.close();
    canvas.width = canvas.height = 0;
  }
}
