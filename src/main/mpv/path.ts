import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import log from '../logger';

/** 各平台的 libmpv 动态库文件名 */
const LIBMPV_NAMES: Record<string, string[]> = {
  win32: ['libmpv-2.dll', 'mpv-2.dll'],
  darwin: ['libmpv.dylib', 'libmpv.2.dylib'],
  linux: ['libmpv.so', 'libmpv.so.2', 'libmpv.so.1'],
};

/**
 * 在目录中递归查找 libmpv 动态库，最多搜索 maxDepth 层。
 */
function findLibmpvRecursive(dir: string, maxDepth = 3): string | null {
  if (maxDepth <= 0 || !fs.existsSync(dir)) return null;

  const names = LIBMPV_NAMES[process.platform] ?? [];
  for (const name of names) {
    const directPath = path.join(dir, name);
    if (fs.existsSync(directPath)) return directPath;
  }

  // 检查 lib 子目录
  const libDir = path.join(dir, 'lib');
  if (fs.existsSync(libDir)) {
    for (const name of names) {
      const libPath = path.join(libDir, name);
      if (fs.existsSync(libPath)) return libPath;
    }
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'lib') continue;
      const found = findLibmpvRecursive(path.join(dir, entry.name), maxDepth - 1);
      if (found) return found;
    }
  } catch {
    // 读取目录失败，忽略
  }

  return null;
}

/** 解析 libmpv 动态库路径，优先使用打包的版本，回退到系统安装 */
export function resolveLibmpvPath(): string | null {
  const resourceBase = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../../build');
  const bundledDir = path.join(resourceBase, 'mpv');

  log.info('[mpv:path] Resolving libmpv library', {
    isPackaged: app.isPackaged,
    resourceBase,
    bundledDir,
    platform: process.platform,
    arch: process.arch,
  });

  // 递归查找打包的 libmpv
  const bundledLib = findLibmpvRecursive(bundledDir);
  if (bundledLib) {
    log.info('[mpv:path] Found bundled libmpv:', bundledLib);
    return bundledLib;
  }

  log.info('[mpv:path] Bundled libmpv not found, trying system paths');

  // 系统路径查找
  if (process.platform === 'darwin') {
    // Homebrew 路径
    const brewPaths = [
      '/opt/homebrew/lib', // arm64
      '/usr/local/lib', // x64
    ];
    for (const dir of brewPaths) {
      const found = findLibmpvRecursive(dir, 1);
      if (found) {
        log.info('[mpv:path] Found system libmpv:', found);
        return found;
      }
    }
  } else if (process.platform === 'linux') {
    const linuxPaths = [
      '/usr/lib',
      '/usr/lib/x86_64-linux-gnu',
      '/usr/lib/aarch64-linux-gnu',
      '/usr/local/lib',
    ];
    for (const dir of linuxPaths) {
      const found = findLibmpvRecursive(dir, 1);
      if (found) {
        log.info('[mpv:path] Found system libmpv:', found);
        return found;
      }
    }
  } else if (process.platform === 'win32') {
    // Windows: 检查 build/mpv 目录（开发环境手动放置）
    const devDir = path.join(__dirname, '../../../build/mpv');
    const found = findLibmpvRecursive(devDir);
    if (found) {
      log.info('[mpv:path] Found dev libmpv:', found);
      return found;
    }
  }

  log.warn('[mpv:path] No libmpv library found');
  return null;
}

/**
 * 获取 libmpv 所在目录的 lib 子目录路径。
 * 用于设置 DLL 搜索路径（Windows）或 DYLD_LIBRARY_PATH（macOS）。
 */
export function resolveLibmpvDir(libmpvPath: string): string {
  return path.dirname(libmpvPath);
}
