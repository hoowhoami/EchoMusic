import { app, nativeImage } from 'electron';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ipcRegistry } from './registry';
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{64}\.png$/.test(id);
const directory = () => path.join(app.getPath('userData'), 'theme-backgrounds');
export function registerThemeAssetHandlers() {
  ipcRegistry.registerHandler('appearance:import-image', async (_event, bytes: Uint8Array) => {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 20 * 1024 * 1024)
      throw new Error('请选择不超过 20 MB 的图片');
    const buffer = Buffer.from(bytes);
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const webp =
      buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpg && !webp) throw new Error('仅支持 JPG、PNG、WebP 图片');
    const image = nativeImage.createFromBuffer(buffer);
    const size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 40_000_000)
      throw new Error('图片无法解码或像素尺寸过大');
    const ratio = Math.min(1, 2560 / Math.max(size.width, size.height));
    const data = (
      ratio < 1
        ? image.resize({
            width: Math.round(size.width * ratio),
            height: Math.round(size.height * ratio),
          })
        : image
    ).toPNG();
    const id = createHash('sha256').update(data).digest('hex') + '.png';
    await mkdir(directory(), { recursive: true });
    await writeFile(path.join(directory(), id), data, { flag: 'wx' }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return { id, url: `data:image/png;base64,${data.toString('base64')}` };
  });
  ipcRegistry.registerHandler('appearance:read-image', async (_event, id: string) => {
    if (!validId(id)) throw new Error('背景资源标识无效');
    const bytes = await readFile(path.join(directory(), id));
    return { url: `data:image/png;base64,${bytes.toString('base64')}` };
  });
  ipcRegistry.registerHandler('appearance:clean-images', async (_event, retained: string[]) => {
    if (!Array.isArray(retained) || retained.some((id) => !validId(id)))
      throw new Error('背景资源列表无效');
    const files = await readdir(directory()).catch(() => []);
    await Promise.all(
      files
        .filter((id) => validId(id) && !retained.includes(id))
        .map((id) =>
          unlink(path.join(directory(), id)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          }),
        ),
    );
  });
}
