import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { DspProviderInspection, DspProviderRecord } from '../../shared/audio';

const METADATA_FILE = 'provider.json';
const PROVIDER_EXTENSIONS = new Set(['.dll', '.dylib', '.so']);
const RETIRE_DELAYS_MS = [50, 150, 500, 1_500, 5_000, 15_000, 60_000] as const;

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

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex');

const hashFile = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });

const normalizeInspection = (value: DspProviderInspection): DspProviderInspection => {
  const providerId = String(value?.providerId ?? '').trim();
  if (!providerId || providerId.length > 256 || /[\u0000-\u001f\u007f]/u.test(providerId)) {
    throw new Error('Provider ID 无效');
  }
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

const readMetadata = async (providerDirectory: string): Promise<ProviderMetadata | null> => {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(metadataPath(providerDirectory), 'utf8'),
    ) as ProviderMetadata;
    if (
      value?.schemaVersion !== 1 ||
      !value.providerId ||
      !value.current?.contentHash ||
      !PROVIDER_EXTENSIONS.has(value.current.extension)
    )
      return null;
    return value;
  } catch {
    return null;
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

const scheduleRetire = (filePath: string, attempt = 0, removeParent = true): void => {
  void fs.promises
    .unlink(filePath)
    .then(() =>
      removeParent ? fs.promises.rmdir(path.dirname(filePath)).catch(() => undefined) : undefined,
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return;
      if (error.code !== 'EPERM' && error.code !== 'EBUSY') return;
      const delay = RETIRE_DELAYS_MS[Math.min(attempt, RETIRE_DELAYS_MS.length - 1)];
      const timer = setTimeout(
        () => scheduleRetire(filePath, attempt + 1, removeParent),
        delay ?? RETIRE_DELAYS_MS[RETIRE_DELAYS_MS.length - 1],
      );
      timer.unref();
    });
};

const collectOldVersions = async (
  providerDirectory: string,
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
    scheduleRetire(path.join(providerDirectory, entry.name));
  }
};

export class DspProviderRegistry {
  private readonly ready: Promise<void>;

  constructor(
    private readonly root: string,
    private readonly inspect: InspectProvider,
  ) {
    this.ready = this.collectStartupGarbage().catch(() => undefined);
  }

  async prepareImport(sourcePath: string): Promise<DspProviderRecord> {
    await this.ready;
    const extension = path.extname(sourcePath).toLowerCase();
    if (!PROVIDER_EXTENSIONS.has(extension)) throw new Error('不支持的 Provider 文件格式');
    await fs.promises.mkdir(this.root, { recursive: true });
    const contentHash = await hashFile(sourcePath);
    const installed = await this.findCurrentByContentHash(contentHash);
    if (installed) return installed;
    const stagingPath = path.join(this.root, `.import-${randomUUID()}${extension}`);
    await fs.promises.copyFile(sourcePath, stagingPath, fs.constants.COPYFILE_EXCL);
    try {
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
    const providerDirectory = path.join(this.root, hashText(record.providerId));
    const existing = await readMetadata(providerDirectory);
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
      legacyPaths: existing?.legacyPaths,
    };
    await writeMetadata(providerDirectory, metadata);
    if (collect) await collectOldVersions(providerDirectory, path.basename(record.path));
    return recordFromMetadata(providerDirectory, metadata);
  }

  async current(providerId: string): Promise<DspProviderRecord | null> {
    await this.ready;
    const providerDirectory = path.join(this.root, hashText(providerId));
    const metadata = await readMetadata(providerDirectory);
    if (!metadata || metadata.providerId !== providerId) return null;
    const record = recordFromMetadata(providerDirectory, metadata);
    return (await fs.promises
      .stat(record.path)
      .then(() => true)
      .catch(() => false))
      ? record
      : null;
  }

  async rollback(candidate: DspProviderRecord, previous: DspProviderRecord | null): Promise<void> {
    await this.ready;
    const providerDirectory = path.join(this.root, hashText(candidate.providerId));
    if (previous) {
      await this.commit(previous, false);
    } else {
      await fs.promises.unlink(metadataPath(providerDirectory)).catch(() => undefined);
    }
    await this.discard(candidate);
  }

  async collect(providerId: string): Promise<void> {
    await this.ready;
    const providerDirectory = path.join(this.root, hashText(providerId));
    const metadata = await readMetadata(providerDirectory);
    if (!metadata) return;
    await collectOldVersions(
      providerDirectory,
      path.basename(versionPath(providerDirectory, metadata)),
    );
  }

  async discard(record: DspProviderRecord): Promise<void> {
    await this.ready;
    const providerDirectory = path.join(this.root, hashText(record.providerId));
    const existing = await readMetadata(providerDirectory);
    if (existing?.current.contentHash === record.contentHash) return;
    scheduleRetire(record.path);
  }

  async list(): Promise<DspProviderRecord[]> {
    await this.ready;
    await fs.promises.mkdir(this.root, { recursive: true });
    await this.collectRootOrphans();
    await this.migrateLegacyFiles();
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const providers: DspProviderRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDirectory = path.join(this.root, entry.name);
      const metadata = await readMetadata(providerDirectory);
      if (!metadata) {
        await collectOldVersions(providerDirectory);
        continue;
      }
      const record = recordFromMetadata(providerDirectory, metadata);
      if (
        !(await fs.promises
          .stat(record.path)
          .then(() => true)
          .catch(() => false))
      )
        continue;
      providers.push(record);
      await collectOldVersions(providerDirectory, path.basename(record.path));
    }
    return providers.sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  async delete(providerId: string): Promise<void> {
    await this.ready;
    const normalizedId = String(providerId ?? '').trim();
    if (!normalizedId) throw new Error('Provider ID 无效');
    const providerDirectory = path.join(this.root, hashText(normalizedId));
    const metadata = await readMetadata(providerDirectory);
    if (!metadata || metadata.providerId !== normalizedId) return;
    await fs.promises
      .unlink(metadataPath(providerDirectory))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await collectOldVersions(providerDirectory);
  }

  private async findCurrentByContentHash(contentHash: string): Promise<DspProviderRecord | null> {
    const entries = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const providerDirectory = path.join(this.root, entry.name);
      const metadata = await readMetadata(providerDirectory);
      if (!metadata || metadata.current.contentHash !== contentHash) continue;
      const record = recordFromMetadata(providerDirectory, metadata);
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
      const metadata = await readMetadata(providerDirectory);
      await collectOldVersions(
        providerDirectory,
        metadata ? path.basename(versionPath(providerDirectory, metadata)) : undefined,
      );
    }
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
        const existing = await readMetadata(providerDirectory);
        const legacyPaths = Array.from(new Set([...(existing?.legacyPaths ?? []), filePath]));
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
        await collectOldVersions(providerDirectory, path.basename(targetPath));
      } catch {
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
        scheduleRetire(filePath, 0, false);
        continue;
      }
      if (!entry.name.startsWith('.import-')) continue;
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs >= 24 * 60 * 60 * 1_000)
        scheduleRetire(filePath, 0, false);
    }
  }
}
