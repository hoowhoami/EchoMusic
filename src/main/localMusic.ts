import type {
  LocalAudioFile,
  LocalAudioMetadata,
  LocalAudioScanOptions,
  LocalAudioScanResult,
} from '../shared/local-music';
import { LOCAL_AUDIO_EXTENSIONS } from '../shared/local-music';
import { readAudioMetadata, resolveAudioTitleAndArtist } from './media/audioMetadata';
import { scanLocalFiles, type ScannedLocalFile } from './media/fileScanner';

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
  const files: LocalAudioFile[] = [];
  // 元数据解析当前串行执行；大目录扫描会等待较久。未来本地音乐正式立项时，
  // 再改为 worker + 并发 + 增量扫描。
  for (const file of scan.files) {
    files.push(await readLocalAudioFile(file));
  }
  return {
    root: scan.root,
    files,
    errors: errors.length > 0 ? errors : undefined,
    limitReached: scan.limitReached,
  };
};
