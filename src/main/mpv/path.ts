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

/** 解析 libmpv 动态库路径 */
export function resolveLibmpvPath(): string | null {
  const resourceBase = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../../build');
  const bundledDir = path.join(resourceBase, 'mpv');

  log.info('[mpv:path] Resolving libmpv library', {
    isPackaged: app.isPackaged,
    platform: process.platform,
  });

  // Linux 平台优先尝试系统库，以解决 Arch 等滚动更新发行版与打包库（通常基于 Ubuntu 构建）的兼容性问题，
  // 同时避免 Electron 内置裁剪版 libffmpeg 与 libmpv 依赖的完整版 libav* 发生符号冲突
  const preferSystem = process.platform === 'linux';

  if (preferSystem) {
    const systemLib = findSystemLibmpv();
    if (systemLib) return systemLib;
  }

  // 尝试打包的库
  const bundledLib = findLibmpvRecursive(bundledDir);
  if (bundledLib) {
    log.info('[mpv:path] Found bundled libmpv:', bundledLib);
    return bundledLib;
  }

  // 非 Linux 平台，或 Linux 下未找到系统库时，作为回退尝试系统库
  if (!preferSystem) {
    const systemLib = findSystemLibmpv();
    if (systemLib) return systemLib;
  }

  log.warn('[mpv:path] No libmpv library found');
  return null;
}

/** 查找系统路径中的 libmpv */
function findSystemLibmpv(): string | null {
  log.info('[mpv:path] Searching for system libmpv');

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

  return null;
}

/**
 * 获取 libmpv 所在目录的 lib 子目录路径。
 * 用于设置 DLL 搜索路径（Windows）或 DYLD_LIBRARY_PATH（macOS）。
 */
export function resolveLibmpvDir(libmpvPath: string): string {
  return path.dirname(libmpvPath);
}
