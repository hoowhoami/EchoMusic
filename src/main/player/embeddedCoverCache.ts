import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 128;
const FILE_NAME = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/;
export const EMBEDDED_COVER_SCHEME = 'echo-player-cover';

const imageType = (data: Uint8Array): string | null => {
  if (data.length < 12) return null;
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (Buffer.from(data.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'png';
  const head = Buffer.from(data.subarray(0, 12)).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'webp';
  return null;
};

/** Content-addressed, bounded artwork storage. No source URL or credentials are stored. */
export class EmbeddedCoverCache {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {}

  /** Native workers publish artwork files; only their small names cross N-API. */
  adopt(name: string): Promise<string | undefined> {
    if (!FILE_NAME.test(name)) return Promise.resolve(undefined);
    const task = this.pending.then(async () => {
      const url = `${EMBEDDED_COVER_SCHEME}://artwork/${name}`;
      const image = await this.resolve(url);
      if (!image) return undefined;
      const now = new Date();
      await fs.utimes(image.filePath, now, now);
      await this.prune(name);
      // Recreated files need a fresh resource identity so an <img> that already
      // failed on an evicted URL retries. Touching an existing entry keeps it stable.
      return `${url}?v=${Math.round(image.createdAt * 1000)}`;
    });
    this.pending = task.catch(() => {});
    return task;
  }

  async resolve(
    url: string,
  ): Promise<{ filePath: string; size: number; mime: string; createdAt: number } | null> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const name = parsed.pathname.slice(1);
    if (
      parsed.protocol !== `${EMBEDDED_COVER_SCHEME}:` ||
      parsed.host !== 'artwork' ||
      !FILE_NAME.test(name) ||
      (parsed.search && !/^\?v=\d{1,20}$/.test(parsed.search)) ||
      parsed.hash
    )
      return null;
    try {
      const filePath = path.join(this.directory, name);
      const stat = await fs.lstat(filePath);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
      // Validate just the signature. The protocol streams the file in native
      // code instead of materializing/copying its full contents in main JS.
      const file = await fs.open(filePath, 'r');
      let ext: string | null;
      try {
        const header = Buffer.alloc(12);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        ext = imageType(header.subarray(0, bytesRead));
      } finally {
        await file.close();
      }
      if (!ext || ext !== name.split('.').pop()) return null;
      return {
        filePath,
        size: stat.size,
        mime: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
        createdAt: stat.birthtimeMs,
      };
    } catch {
      return null;
    }
  }

  private async prune(retain: string): Promise<void> {
    const names = (await fs.readdir(this.directory)).filter((name) => FILE_NAME.test(name));
    const files = await Promise.all(
      names.map(async (name) => ({ name, ...(await fs.stat(path.join(this.directory, name))) })),
    );
    files.sort((a, b) => (a.name === retain ? -1 : b.name === retain ? 1 : b.mtimeMs - a.mtimeMs));
    let count = 0;
    let bytes = 0;
    for (const file of files) {
      count += 1;
      bytes += file.size;
      if (file.name !== retain && (count > MAX_CACHE_FILES || bytes > MAX_CACHE_BYTES))
        await fs.unlink(path.join(this.directory, file.name));
    }
  }
}
