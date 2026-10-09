import { app, nativeImage } from 'electron';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ipcRegistry } from './registry';
import {
  MAX_THEME_IMAGE_EDGE,
  MAX_THEME_IMAGE_PNG_BYTES,
  type ThemeImageImportResult,
} from '../../shared/themeImage';
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-f0-9]{64}\.png$/.test(id);
const directory = () => path.join(app.getPath('userData'), 'theme-backgrounds');
export function registerThemeAssetHandlers() {
  ipcRegistry.registerHandler(
    'appearance:import-image',
    async (_event, bytes: Uint8Array): Promise<ThemeImageImportResult> => {
      if (
        !(bytes instanceof Uint8Array) ||
        !bytes.byteLength ||
        bytes.byteLength > MAX_THEME_IMAGE_PNG_BYTES
      )
        return { ok: false, error: '图片处理数据无效，请重新选择图片' };
      const buffer = Buffer.from(bytes);
      const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (!png || buffer.length < 24 || buffer.toString('ascii', 12, 16) !== 'IHDR')
        return { ok: false, error: '图片处理格式无效，请重新选择图片' };
      const width = buffer.readUInt32BE(16),
        height = buffer.readUInt32BE(20);
      if (!width || !height || Math.max(width, height) > MAX_THEME_IMAGE_EDGE)
        return { ok: false, error: '图片尚未完成缩放，请重新导入' };
      const image = nativeImage.createFromBuffer(buffer);
      const size = image.getSize();
      if (image.isEmpty()) return { ok: false, error: '图片无法解码，请重新选择图片' };
      if (Math.max(size.width, size.height) > MAX_THEME_IMAGE_EDGE)
        return { ok: false, error: '图片尚未完成缩放，请重新导入' };
      const data = buffer;
      const id = createHash('sha256').update(data).digest('hex') + '.png';
      await mkdir(directory(), { recursive: true });
      await writeFile(path.join(directory(), id), data, { flag: 'wx' }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      return { ok: true, id, url: `data:image/png;base64,${data.toString('base64')}` };
    },
  );
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
