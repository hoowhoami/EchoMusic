import type {
  LocalAudioFile,
  LocalAudioMetadata,
  LocalAudioScanOptions,
  LocalAudioScanResult,
} from '../shared/localMusic';
import { LOCAL_AUDIO_EXTENSIONS } from '../shared/localMusic';
import { readAudioMetadata, resolveAudioTitleAndArtist } from './media/audioMetadata';
import { scanLocalFiles, type ScannedLocalFile } from './media/fileScanner';

const METADATA_CONCURRENCY = 4;

export const readLocalAudioFile = async (file: ScannedLocalFile): Promise<LocalAudioFile> => {
  let metadata: LocalAudioMetadata | undefined;
  try {
    metadata = await readAudioMetadata(file.path);
  } catch {
    metadata = undefined;
  }
  const { title, artist } = resolveAudioTitleAndArtist(file.name, metadata);
  return {
    name: file.name,
    path: file.path,
    size: file.size,
    modifiedAt: file.modifiedAt,
    extension: file.extension,
    relativePath: file.relativePath,
    title,
    artist,
    album: metadata?.album,
    duration: metadata?.duration,
  };
};

export const scanLocalAudioFiles = async (
  directoryPath: string,
  options: LocalAudioScanOptions = {},
): Promise<LocalAudioScanResult> => {
  const errors: string[] = [];
  const scan = await scanLocalFiles(directoryPath, {
    recursive: options.recursive ?? true,
    includeHidden: Boolean(options.includeHidden),
    limit: options.limit,
    maxDepth: options.maxDepth,
    maxFileSize: options.maxFileSize,
    extensions: LOCAL_AUDIO_EXTENSIONS,
    onError: (message) => errors.push(message),
  });
  const files = new Array<LocalAudioFile>(scan.files.length);
  let nextIndex = 0;
  // Bound open files and retain scanner order even when parsers finish out of order.
  await Promise.all(
    Array.from({ length: Math.min(METADATA_CONCURRENCY, scan.files.length) }, async () => {
      while (nextIndex < scan.files.length) {
        const index = nextIndex++;
        files[index] = await readLocalAudioFile(scan.files[index]);
      }
    }),
  );
  return {
    root: scan.root,
    files,
    errors: errors.length > 0 ? errors : undefined,
    limitReached: scan.limitReached,
  };
};
