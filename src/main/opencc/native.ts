import { app } from 'electron';
import { createRequire } from 'node:module';
import { join } from 'path';
import log from 'electron-log/main';

import { isOpenccProfile, type OpenccProfile } from '../../shared/opencc';

export interface NativeOpenccAddon {
  convert(text: string, profile: OpenccProfile): string;
  convertBatch(texts: string[], profile: OpenccProfile): string[];
}

let addon: NativeOpenccAddon | null = null;
let unavailableLogged = false;
const nativeRequire = createRequire(join(process.cwd(), 'package.json'));

const loadNativeOpenccAddon = (): NativeOpenccAddon | null => {
  if (addon) return addon;

  const primaryPath = app.isPackaged
    ? join(process.resourcesPath, 'native', 'echo-opencc.node')
    : join(__dirname, '../../native/echo-opencc/echo-opencc.node');

  try {
    addon = nativeRequire(primaryPath) as NativeOpenccAddon;
    return addon;
  } catch (primaryError) {
    try {
      addon = nativeRequire(join(process.cwd(), 'native/echo-opencc')) as NativeOpenccAddon;
      return addon;
    } catch (fallbackError) {
      if (!unavailableLogged) {
        unavailableLogged = true;
        log.warn('[OpenCC] Native addon is unavailable', {
          primary: primaryError instanceof Error ? primaryError.message : String(primaryError),
          fallback: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
      }
      return null;
    }
  }
};

const normalizeInputTexts = (texts: unknown): string[] => {
  if (!Array.isArray(texts)) return [];
  return texts.map((text) => String(text ?? ''));
};

export const convertOpenccBatch = (texts: unknown, profile: unknown): string[] => {
  const normalizedTexts = normalizeInputTexts(texts);
  if (!isOpenccProfile(profile)) return normalizedTexts;
  const nativeOpencc = loadNativeOpenccAddon();
  if (!nativeOpencc) return normalizedTexts;
  return nativeOpencc.convertBatch(normalizedTexts, profile);
};
