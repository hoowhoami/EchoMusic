import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

/** 解析 mpv 二进制路径，优先使用打包的版本，回退到系统 PATH */
export function resolveMpvPath(): string | null {
  // 打包在 extraResources 中的 mpv
  const resourceBase = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '../../../build');
  const bundledDir = path.join(resourceBase, 'mpv');
  const bundledBin =
    process.platform === 'win32' ? path.join(bundledDir, 'mpv.exe') : path.join(bundledDir, 'mpv');

  if (fs.existsSync(bundledBin)) {
    return bundledBin;
  }

  // 开发环境或 Linux：尝试系统 PATH
  const cmd = process.platform === 'win32' ? 'where mpv.exe' : 'which mpv';
  try {
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 3000 }).trim();
    if (result) return result.split('\n')[0].trim();
  } catch {
    // 未找到
  }

  return null;
}
