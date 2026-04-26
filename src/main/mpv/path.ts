import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import log from '../logger';

const MPV_BIN_NAME = process.platform === 'win32' ? 'mpv.exe' : 'mpv';

/**
 * 在目录中递归查找 mpv 二进制，最多搜索 maxDepth 层。
 * 兼容 7z 解压后带子目录的情况（如 mpv-x86_64-xxx/mpv.exe）。
 */
function findMpvBinRecursive(dir: string, maxDepth = 3): string | null {
  if (maxDepth <= 0 || !fs.existsSync(dir)) return null;

  const directPath = path.join(dir, MPV_BIN_NAME);
  if (fs.existsSync(directPath)) return directPath;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findMpvBinRecursive(path.join(dir, entry.name), maxDepth - 1);
      if (found) return found;
    }
  } catch {
    // 读取目录失败，忽略
  }

  return null;
}

/** 解析 mpv 二进制路径，优先使用打包的版本，回退到系统 PATH */
export function resolveMpvPath(): string | null {
  const resourceBase = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../../build');
  const bundledDir = path.join(resourceBase, 'mpv');

  log.info('[mpv:path] Resolving mpv binary', {
    isPackaged: app.isPackaged,
    resourceBase,
    bundledDir,
    platform: process.platform,
    arch: process.arch,
  });

  // 递归查找，兼容子目录
  const bundledBin = findMpvBinRecursive(bundledDir);
  if (bundledBin) {
    log.info('[mpv:path] Found bundled mpv binary:', bundledBin);
    return bundledBin;
  }

  log.info('[mpv:path] Bundled mpv not found, trying system PATH');

  // 开发环境或 Linux：尝试系统 PATH
  const cmd = process.platform === 'win32' ? 'where mpv.exe' : 'which mpv';
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) {
      const systemBin = result.split('\n')[0].trim();
      log.info('[mpv:path] Found system mpv binary:', systemBin);
      return systemBin;
    }
  } catch {
    // 未找到
  }

  log.warn('[mpv:path] No mpv binary found');
  return null;
}

/**
 * 获取 mpv 二进制所在目录的 lib 子目录路径。
 * 用于设置 DYLD_LIBRARY_PATH / LD_LIBRARY_PATH。
 */
export function resolveMpvLibDir(mpvBinPath: string): string | null {
  const binDir = path.dirname(mpvBinPath);
  // lib 目录可能和 mpv 同级，也可能在上一级
  const candidates = [path.join(binDir, 'lib'), path.join(path.dirname(binDir), 'lib')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
