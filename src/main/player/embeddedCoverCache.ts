import { promises as fs } from 'node:fs';
import path from 'node:path';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 128;
const FILE_NAME = /^[a-f0-9]{64}\.(?:jpg|png|webp|gif)$/;
// prune 触发节流：次数/时间双阈值（见 shouldPrune）
const PRUNE_EVERY_ADOPTS = 16;
const PRUNE_MIN_INTERVAL_MS = 60_000;
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
  private pruneAdoptCount = 0;
  private lastPruneAt = 0;
  /** adopt 时维护的目录库存；首次使用时从磁盘初始化，prune 后按实际保留文件重建。 */
  private trackedFiles: Map<string, number> | null = null;
  private trackedBytes = 0;
  /** 每个封面文件的版本令牌与文件身份；同名文件被重建时更换令牌，让前端重试已失败的 URL。 */
  private fileVersions = new Map<string, { identity: string; version: number }>();
  private versionClock = Math.round(Date.now() * 1000);

  constructor(readonly directory: string) {}

  /** 首次 adopt 时扫描一次目录，之后依靠 adopt/prune 增量维护，避免每次发布都 readdir。 */
  private async ensureInventory(): Promise<Map<string, number>> {
    if (this.trackedFiles) return this.trackedFiles;
    const names = (await fs.readdir(this.directory)).filter((name) => FILE_NAME.test(name));
    const entries = await Promise.all(
      names.map(async (name) => {
        try {
          const stat = await fs.stat(path.join(this.directory, name));
          return [name, stat.size] as const;
        } catch {
          return null;
        }
      }),
    );
    const files = new Map<string, number>();
    let bytes = 0;
    for (const entry of entries) {
      if (!entry) continue;
      files.set(entry[0], entry[1]);
      bytes += entry[1];
    }
    this.trackedFiles = files;
    this.trackedBytes = bytes;
    return files;
  }

  private async trackAdopted(name: string, size: number): Promise<void> {
    const files = await this.ensureInventory();
    this.trackedBytes += size - (files.get(name) ?? 0);
    files.set(name, size);
  }

  // prune 需要全目录 readdir + 逐文件 stat（≤128 个文件），每次封面发布都执行会与
  // 切歌瞬间的元数据解析、UI 首帧竞争 IO；普通情况下按次数/时间双阈值节流，
  // 但内存库存一旦超过硬上限就立即 prune，MAX_CACHE_FILES/MAX_CACHE_BYTES 仍是硬约束。
  private shouldPrune(): boolean {
    const overLimit =
      (this.trackedFiles?.size ?? 0) > MAX_CACHE_FILES || this.trackedBytes > MAX_CACHE_BYTES;
    this.pruneAdoptCount += 1;
    const now = Date.now();
    if (
      !overLimit &&
      this.pruneAdoptCount < PRUNE_EVERY_ADOPTS &&
      now - this.lastPruneAt < PRUNE_MIN_INTERVAL_MS
    ) {
      return false;
    }
    this.pruneAdoptCount = 0;
    this.lastPruneAt = now;
    return true;
  }

  /** Native workers publish artwork files; only their small names cross N-API. */
  adopt(name: string): Promise<string | undefined> {
    if (!FILE_NAME.test(name)) return Promise.resolve(undefined);
    const task = this.pending.then(async () => {
      const url = `${EMBEDDED_COVER_SCHEME}://artwork/${name}`;
      const image = await this.resolve(url);
      if (!image) return undefined;
      const now = new Date();
      await fs.utimes(image.filePath, now, now);
      await this.trackAdopted(name, image.size);
      if (this.shouldPrune()) await this.prune(name);
      // 重建文件需要新的资源身份，让已失败的 <img> 重试；重复 adopt 同一文件时保持稳定。
      // 不能只靠 birthtime：Windows 的 NTFS tunneling 会在删除后 15 秒内保留创建时间。
      const identity = `${image.createdAt}:${image.ino}:${image.size}`;
      const previousVersion = this.fileVersions.get(name);
      let version: number;
      if (previousVersion?.identity === identity) {
        version = previousVersion.version;
      } else {
        version = ++this.versionClock;
        this.fileVersions.set(name, { identity, version });
      }
      return `${url}?v=${version}`;
    });
    this.pending = task.catch(() => {});
    return task;
  }

  async resolve(url: string): Promise<{
    filePath: string;
    size: number;
    mime: string;
    createdAt: number;
    ino: number;
  } | null> {
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
        ino: stat.ino,
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
    // 保留当前文件在前，其余按 mtime 从新到旧排列，优先淘汰最旧的文件。
    files.sort((a, b) => (a.name === retain ? -1 : b.name === retain ? 1 : b.mtimeMs - a.mtimeMs));
    const kept = new Map<string, number>();
    let count = 0;
    let bytes = 0;
    for (const file of files) {
      const keep =
        file.name === retain || (count < MAX_CACHE_FILES && bytes + file.size <= MAX_CACHE_BYTES);
      if (!keep) {
        await fs.unlink(path.join(this.directory, file.name));
        this.fileVersions.delete(file.name);
        continue;
      }
      count += 1;
      bytes += file.size;
      kept.set(file.name, file.size);
    }
    // 以实际保留文件重建库存，后续 adopt 可继续做精确的硬上限判定。
    this.trackedFiles = kept;
    this.trackedBytes = bytes;
    for (const name of this.fileVersions.keys()) {
      if (!kept.has(name)) this.fileVersions.delete(name);
    }
  }
}
