import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import type { DspProviderInspection, DspProviderRecord } from '../../shared/audio';

const METADATA_FILE = 'provider.json';
const PROVIDER_EXTENSIONS = new Set(['.dll', '.dylib', '.so']);
const RETIRE_DELAYS_MS = [50, 150, 500, 1_500, 5_000, 15_000, 60_000] as const;
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u;

interface ProviderMetadata {
  schemaVersion: 1;
  providerId: string;
  current: {
    contentHash: string;
    extension: string;
    originalFileName: string;
    importedAt: number;
    inspection: DspProviderInspection;
  };
  legacyPaths?: string[];
}

type InspectProvider = (providerPath: string) => Promise<DspProviderInspection>;
type ReportIssue = (message: string, error?: unknown) => void;
type MetadataReadResult =
  | { status: 'missing' }
  | { status: 'valid'; metadata: ProviderMetadata }
  | { status: 'invalid'; error: Error };

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

const hashFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });

const copyFileAndHash = async (sourcePath: string, targetPath: string): Promise<string> => {
  const hash = createHash('sha256');
  const input = fs.createReadStream(sourcePath);
  input.on('data', (chunk) => hash.update(chunk));
  await pipeline(input, fs.createWriteStream(targetPath, { flags: 'wx' }));
  return hash.digest('hex');
};

const normalizeProviderId = (value: unknown): string => {
  const providerId = typeof value === 'string' ? value.trim() : '';
  if (!providerId || providerId.length > 256 || /[\u0000-\u001f\u007f]/u.test(providerId)) {
    throw new Error('Provider ID 无效');
  }
  return providerId;
};

const normalizeInspection = (value: DspProviderInspection): DspProviderInspection => {
  const providerId = normalizeProviderId(value?.providerId);
  return {
    providerId,
    providerVersion: String(value.providerVersion ?? '').trim(),
    latencyFrames: Number(value.latencyFrames) || 0,
    preferredBlockFrames: Number(value.preferredBlockFrames) || 0,
    maxChannels: Number(value.maxChannels) || 0,
    manifestJson: String(value.manifestJson ?? ''),
    stateJson: String(value.stateJson ?? ''),
  };
};

const metadataPath = (providerDirectory: string): string =>
  path.join(providerDirectory, METADATA_FILE);

const versionPath = (providerDirectory: string, metadata: ProviderMetadata): string =>
  path.join(providerDirectory, `${metadata.current.contentHash}${metadata.current.extension}`);

const recordFromMetadata = (
  providerDirectory: string,
  metadata: ProviderMetadata,
): DspProviderRecord => ({
  ...metadata.current.inspection,
  providerId: metadata.providerId,
  path: versionPath(providerDirectory, metadata),
  contentHash: metadata.current.contentHash,
  originalFileName: metadata.current.originalFileName,
  importedAt: metadata.current.importedAt,
  legacyPaths: metadata.legacyPaths,
});

const readMetadata = async (providerDirectory: string): Promise<MetadataReadResult> => {
  let serialized: string;
  try {
    serialized = await fs.promises.readFile(metadataPath(providerDirectory), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'invalid',
      error: new Error('Provider 元数据无法读取', { cause: error }),
    };
  }
  try {
    const value = JSON.parse(serialized) as ProviderMetadata;
    const providerId = normalizeProviderId(value?.providerId);
    if (
      value?.schemaVersion !== 1 ||
      !CONTENT_HASH_PATTERN.test(value.current?.contentHash ?? '') ||
      !PROVIDER_EXTENSIONS.has(value.current?.extension) ||
      path.basename(providerDirectory) !== hashText(providerId) ||
      normalizeProviderId(value.current?.inspection?.providerId) !== providerId
    )
      throw new Error('Provider 元数据格式或目录身份无效');
    return { status: 'valid', metadata: value };
  } catch (error) {
    return {
      status: 'invalid',
      error: new Error('Provider 元数据无法解析或版本不受支持', { cause: error }),
    };
  }
};

const writeMetadata = async (
  providerDirectory: string,
  metadata: ProviderMetadata,
): Promise<void> => {
  const temporaryPath = path.join(providerDirectory, `.provider-${randomUUID()}.json.tmp`);
  await fs.promises.writeFile(temporaryPath, JSON.stringify(metadata, null, 2), {
    encoding: 'utf8',
    flag: 'wx',
  });
  try {
    await fs.promises.rename(temporaryPath, metadataPath(providerDirectory));
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const scheduleRetire = (
  filePath: string,
  reportIssue: ReportIssue,
  retiring: Set<string>,
  attempt = 0,
  removeParent = true,
): void => {
  if (attempt === 0) {
    if (retiring.has(filePath)) return;
    retiring.add(filePath);
  }
  void fs.promises
    .unlink(filePath)
    .then(() => {
      retiring.delete(filePath);
      if (removeParent) void fs.promises.rmdir(path.dirname(filePath)).catch(() => undefined);
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        retiring.delete(filePath);
        return;
      }
      if (
        (error.code !== 'EPERM' && error.code !== 'EBUSY') ||
        attempt >= RETIRE_DELAYS_MS.length
      ) {
        retiring.delete(filePath);
        reportIssue(`Provider 文件回收失败: ${filePath}`, error);
        return;
      }
      const delay = RETIRE_DELAYS_MS[attempt];
      const timer = setTimeout(
        () => scheduleRetire(filePath, reportIssue, retiring, attempt + 1, removeParent),
        delay,
      );
      timer.unref();
    });
};

const collectOldVersions = async (
  providerDirectory: string,
  reportIssue: ReportIssue,
  retiring: Set<string>,
  keepFileName?: string,
): Promise<void> => {
  const entries = await fs.promises
    .readdir(providerDirectory, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || entry.name === METADATA_FILE || entry.name === keepFileName) continue;
    if (entry.name.startsWith('.provider-') || entry.name.startsWith('.import-')) {
      const stat = await fs.promises
        .stat(path.join(providerDirectory, entry.name))
        .catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1_000) continue;
    }
    scheduleRetire(path.join(providerDirectory, entry.name), reportIssue, retiring);
  }
};

export class DspProviderRegistry {
  private readonly ready: Promise<void>;
  private legacyMigration: Promise<void> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly reportedMetadataErrors = new Set<string>();
  private readonly retiring = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly inspect: InspectProvider,
    private readonly reportIssue: ReportIssue = (message, error) => console.warn(message, error),
  ) {
    this.ready = this.collectStartupGarbage().catch((error) => {
      this.reportIssue('Provider 启动回收失败', error);
    });
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async prepareImport(sourcePath: string): Promise<DspProviderRecord> {
    await this.ready;
    const extension = path.extname(sourcePath).toLowerCase();
    if (!PROVIDER_EXTENSIONS.has(extension)) throw new Error('不支持的 Provider 文件格式');
    await fs.promises.mkdir(this.root, { recursive: true });
    const sourceHash = await hashFile(sourcePath);
    const installed = await this.findCurrentByContentHash(sourceHash);
    if (installed) return installed;
    const stagingPath = path.join(this.root, `.import-${randomUUID()}${extension}`);
    try {
      // Preserve zero-write duplicate imports, but hash the actual copied byte stream again so
      // replacing the selected source during import can never mismatch the installed filename.
      const contentHash = await copyFileAndHash(sourcePath, stagingPath);
      const installedAfterCopy = await this.findCurrentByContentHash(contentHash);
      if (installedAfterCopy) {
        await fs.promises.unlink(stagingPath);
        return installedAfterCopy;
      }
      const inspection = normalizeInspection(await this.inspect(stagingPath));
      const providerDirectory = path.join(this.root, hashText(inspection.providerId));
      const targetPath = path.join(providerDirectory, `${contentHash}${extension}`);
      await fs.promises.mkdir(providerDirectory, { recursive: true });
      if (
        await fs.promises
          .stat(targetPath)
          .then(() => true)
          .catch(() => false)
      ) {
        await fs.promises.unlink(stagingPath);
      } else {
        await fs.promises.rename(stagingPath, targetPath);
      }
      return {
        ...inspection,
        path: targetPath,
        contentHash,
        originalFileName: path.basename(sourcePath),
        importedAt: Date.now(),
      };
    } catch (error) {
      await fs.promises.unlink(stagingPath).catch(() => undefined);
      throw error;
    }
  }

  async commit(record: DspProviderRecord, collect = true): Promise<DspProviderRecord> {
    await this.ready;
    this.assertManagedRecordPath(record);
    const providerDirectory = path.join(this.root, hashText(record.providerId));
    const existing = await this.readProviderMetadata(providerDirectory);
    if (existing.status === 'invalid') throw existing.error;
    const extension = path.extname(record.path).toLowerCase();
    const metadata: ProviderMetadata = {
      schemaVersion: 1,
      providerId: record.providerId,
      current: {
        contentHash: record.contentHash,
        extension,
        originalFileName: record.originalFileName,
        importedAt: record.importedAt,
        inspection: normalizeInspection(record),
      },
      legacyPaths: existing.status === 'valid' ? existing.metadata.legacyPaths : undefined,
    };
    await writeMetadata(providerDirectory, metadata);
    if (collect)
      await collectOldVersions(
        providerDirectory,
        this.reportIssue,
        this.retiring,
        path.basename(record.path),
      );
    return recordFromMetadata(providerDirectory, metadata);
  }

  async current(providerId: string): Promise<DspProviderRecord | null> {
    await this.ready;
    const normalizedId = normalizeProviderId(providerId);
    const providerDirectory = path.join(this.root, hashText(normalizedId));
    const result = await this.readProviderMetadata(providerDirectory);
    if (result.status !== 'valid' || result.metadata.providerId !== normalizedId) return null;
    const record = recordFromMetadata(providerDirectory, result.metadata);
    return (await fs.promises
      .stat(record.path)
      .then(() => true)
      .catch(() => false))
      ? record
      : null;
  }

  async rollback(candidate: DspProviderRecord, previous: DspProviderRecord | null): Promise<void> {
    await this.ready;
    this.assertManagedRecordPath(candidate);
    const providerDirectory = path.join(this.root, hashText(candidate.providerId));
    if (previous) {
      await this.commit(previous, false);
    } else {
      const installed = await this.readProviderMetadata(providerDirectory);
      if (
        installed.status === 'valid' &&
        installed.metadata.current.contentHash === candidate.contentHash
      ) {
        await fs.promises.unlink(metadataPath(providerDirectory)).catch(() => undefined);
      }
    }
    await this.discard(candidate);
  }

  async collect(providerId: string): Promise<void> {
    await this.ready;
    const normalizedId = normalizeProviderId(providerId);
    const providerDirectory = path.join(this.root, hashText(normalizedId));
    const result = await this.readProviderMetadata(providerDirectory);
    if (result.status !== 'valid') return;
    await collectOldVersions(
      providerDirectory,
      this.reportIssue,
      this.retiring,
      path.basename(versionPath(providerDirectory, result.metadata)),
    );
  }

  async discard(record: DspProviderRecord): Promise<void> {
    await this.ready;
    this.assertManagedRecordPath(record);
    const providerDirectory = path.join(this.root, hashText(record.providerId));
    const existing = await this.readProviderMetadata(providerDirectory);
    if (existing.status === 'invalid') return;
    if (existing.status === 'valid' && existing.metadata.current.contentHash === record.contentHash)
      return;
    scheduleRetire(record.path, this.reportIssue, this.retiring);
  }

  async list(): Promise<DspProviderRecord[]> {
    await this.ready;
    await fs.promises.mkdir(this.root, { recursive: true });
    await this.collectRootOrphans();
    await this.ensureLegacyMigration();
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const providers: DspProviderRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDirectory = path.join(this.root, entry.name);
      const result = await this.readProviderMetadata(providerDirectory);
      if (result.status === 'missing') {
        await collectOldVersions(providerDirectory, this.reportIssue, this.retiring);
        continue;
      }
      if (result.status === 'invalid') continue;
      const record = recordFromMetadata(providerDirectory, result.metadata);
      if (
        !(await fs.promises
          .stat(record.path)
          .then(() => true)
          .catch(() => false))
      )
        continue;
      providers.push(record);
      await collectOldVersions(
        providerDirectory,
        this.reportIssue,
        this.retiring,
        path.basename(record.path),
      );
    }
    return providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async delete(providerId: string): Promise<void> {
    await this.ready;
    const normalizedId = normalizeProviderId(providerId);
    const providerDirectory = path.join(this.root, hashText(normalizedId));
    const result = await this.readProviderMetadata(providerDirectory);
    if (result.status === 'invalid') throw result.error;
    if (result.status === 'missing' || result.metadata.providerId !== normalizedId) return;
    await fs.promises
      .unlink(metadataPath(providerDirectory))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await collectOldVersions(providerDirectory, this.reportIssue, this.retiring);
  }

  private async findCurrentByContentHash(contentHash: string): Promise<DspProviderRecord | null> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDirectory = path.join(this.root, entry.name);
      const result = await this.readProviderMetadata(providerDirectory);
      if (result.status !== 'valid' || result.metadata.current.contentHash !== contentHash)
        continue;
      const record = recordFromMetadata(providerDirectory, result.metadata);
      if (
        await fs.promises
          .stat(record.path)
          .then(() => true)
          .catch(() => false)
      )
        return record;
    }
    return null;
  }

  private async collectStartupGarbage(): Promise<void> {
    await fs.promises.mkdir(this.root, { recursive: true });
    await this.collectRootOrphans();
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDirectory = path.join(this.root, entry.name);
      const result = await this.readProviderMetadata(providerDirectory);
      if (result.status === 'invalid') continue;
      await collectOldVersions(
        providerDirectory,
        this.reportIssue,
        this.retiring,
        result.status === 'valid'
          ? path.basename(versionPath(providerDirectory, result.metadata))
          : undefined,
      );
    }
  }

  private async ensureLegacyMigration(): Promise<void> {
    this.legacyMigration ??= this.migrateLegacyFiles();
    await this.legacyMigration;
  }

  private async readProviderMetadata(providerDirectory: string): Promise<MetadataReadResult> {
    const result = await readMetadata(providerDirectory);
    if (result.status === 'invalid' && !this.reportedMetadataErrors.has(providerDirectory)) {
      this.reportedMetadataErrors.add(providerDirectory);
      this.reportIssue(
        `Provider 元数据无效或版本不兼容，已保留目录: ${providerDirectory}`,
        result.error,
      );
    }
    return result;
  }

  private assertManagedRecordPath(record: DspProviderRecord): void {
    const providerId = normalizeProviderId(record.providerId);
    if (providerId !== record.providerId || !CONTENT_HASH_PATTERN.test(record.contentHash)) {
      throw new Error('Provider 记录身份或内容哈希无效');
    }
    const extension = path.extname(record.path).toLowerCase();
    if (!PROVIDER_EXTENSIONS.has(extension)) throw new Error('Provider 记录扩展名无效');
    const providerDirectory = path.resolve(this.root, hashText(providerId));
    const expectedPath = path.join(providerDirectory, `${record.contentHash}${extension}`);
    if (path.resolve(record.path) !== expectedPath) throw new Error('Provider 记录路径越界');
  }

  private async migrateLegacyFiles(): Promise<void> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const legacy = await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() && PROVIDER_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
        )
        .map(async (entry) => {
          const filePath = path.join(this.root, entry.name);
          const stat = await fs.promises.stat(filePath);
          return { filePath, entry, stat };
        }),
    );
    legacy.sort((left, right) => left.stat.mtimeMs - right.stat.mtimeMs);
    for (const { filePath, entry, stat } of legacy) {
      try {
        const inspection = normalizeInspection(await this.inspect(filePath));
        const contentHash = await hashFile(filePath);
        const extension = path.extname(entry.name).toLowerCase();
        const providerDirectory = path.join(this.root, hashText(inspection.providerId));
        const targetPath = path.join(providerDirectory, `${contentHash}${extension}`);
        await fs.promises.mkdir(providerDirectory, { recursive: true });
        const existing = await this.readProviderMetadata(providerDirectory);
        if (existing.status === 'invalid') throw existing.error;
        if (
          await fs.promises
            .stat(targetPath)
            .then(() => true)
            .catch(() => false)
        ) {
          await fs.promises.unlink(filePath);
        } else {
          await fs.promises.rename(filePath, targetPath);
        }
        const legacyPaths = Array.from(
          new Set([
            ...(existing.status === 'valid' ? (existing.metadata.legacyPaths ?? []) : []),
            filePath,
          ]),
        );
        await writeMetadata(providerDirectory, {
          schemaVersion: 1,
          providerId: inspection.providerId,
          current: {
            contentHash,
            extension,
            originalFileName: entry.name,
            importedAt: stat.mtimeMs || Date.now(),
            inspection,
          },
          legacyPaths,
        });
        await collectOldVersions(
          providerDirectory,
          this.reportIssue,
          this.retiring,
          path.basename(targetPath),
        );
      } catch (error) {
        this.reportIssue(`旧版 Provider 迁移失败，已保留原文件: ${filePath}`, error);
        // Leave an invalid legacy file untouched so the user can inspect or remove it manually.
      }
    }
  }

  private async collectRootOrphans(): Promise<void> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.root, entry.name);
      if (entry.name.endsWith('.echo-loaded')) {
        scheduleRetire(filePath, this.reportIssue, this.retiring, 0, false);
        continue;
      }
      if (!entry.name.startsWith('.import-')) continue;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs >= 24 * 60 * 60 * 1_000)
        scheduleRetire(filePath, this.reportIssue, this.retiring, 0, false);
    }
  }
}
