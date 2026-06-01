export interface ImpulseResponseFile {
  id: string;
  name: string;
  path: string;
  size: number;
  importedAt: number;
}

export interface ImportImpulseResponseResult {
  canceled: boolean;
  file?: ImpulseResponseFile;
  error?: string;
}

export interface ImpulseResponsePlaybackOptions {
  filePath: string;
  mix: number;
}

export const normalizeImpulseResponseName = (name: string): string => {
  const normalized = String(name ?? '')
    .trim()
    .replace(/\.irs$/i, '')
    .trim();
  return normalized || '未命名 IRS';
};
