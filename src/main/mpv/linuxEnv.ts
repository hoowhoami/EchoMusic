/**
 * Linux 平台 libmpv 环境修复模块
 *
 * 解决核心问题：Electron 内置裁剪版 libffmpeg（仅含解码器，无网络协议支持）
 * 与系统 libmpv 依赖的完整版 libav* 产生符号冲突，导致网络音频流无法播放。
 *
 * 策略：在进程启动最早期检测并通过 LD_PRELOAD 预加载系统完整版 libav*，
 * 如果当前进程未正确设置则自动 relaunch。
 */

import { app } from 'electron';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/** 标记环境变量，防止无限重启 */
const RELAUNCH_FLAG = 'ECHO_MUSIC_LIBMPV_ENV_FIXED';

/** 需要预加载的 libav* 库（按依赖顺序） */
const PRELOAD_LIB_PATTERNS = [
  'libavutil.so.*',
  'libswresample.so.*',
  'libavcodec.so.*',
  'libavformat.so.*',
  'libswscale.so.*',
  'libavfilter.so.*',
];

/** 系统库搜索路径（覆盖主流发行版） */
const SYSTEM_LIB_PATHS = [
  '/usr/lib/x86_64-linux-gnu', // Debian/Ubuntu x64
  '/usr/lib/aarch64-linux-gnu', // Debian/Ubuntu arm64
  '/usr/lib/i386-linux-gnu', // Debian/Ubuntu i386
  '/usr/lib64', // Fedora/RHEL/openSUSE x64
  '/usr/lib', // Arch/Manjaro/CachyOS（无多架构子目录）
  '/usr/local/lib', // 手动编译安装
  '/usr/local/lib64',
];

/**
 * 在指定目录中查找 libmpv 动态库
 */
function findLibmpvInDir(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const names = ['libmpv.so.2', 'libmpv.so.1', 'libmpv.so'];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

/**
 * 查找系统 libmpv 所在目录
 */
function findSystemLibmpvDir(): string | null {
  for (const dir of SYSTEM_LIB_PATHS) {
    if (findLibmpvInDir(dir)) return dir;
  }
  return null;
}

/**
 * 在目录中查找带版本号的 so 文件
 * 例如 baseName='libavutil.so.' 匹配 libavutil.so.60 等
 * 优先返回最短文件名（主版本号链接，如 libavutil.so.60 而非 libavutil.so.60.3.100）
 */
function findVersionedLib(dir: string, dirEntries: string[], pattern: string): string | null {
  // pattern 格式: libavutil.so.*
  const baseName = pattern.replace('.*', '');

  const matches = dirEntries
    .filter((e) => {
      if (!e.startsWith(baseName)) return false;
      const suffix = e.slice(baseName.length);
      // 版本后缀可能以点号开头，如 libavformat.so.62 → '.62'
      return /^\.?\d+/.test(suffix);
    })
    .sort((a, b) => a.length - b.length);

  if (matches.length > 0) {
    return path.join(dir, matches[0]);
  }
  return null;
}

/**
 * 通过 ldd 查询 libmpv 实际依赖的 libav* 库路径。
 *
 * 当系统存在多套 FFmpeg（如 ffmpeg4.4 与 ffmpeg 8.1 共存）时，
 * 目录扫描可能因文件名排序选错版本。而 ldd 直接输出动态链接器
 * 解析后的实际依赖路径，精确匹配 libmpv 正在使用的那一套。
 *
 * 失败时返回空数组，由调用者决定是否回退其他方式。
 */
function getLibAvDepsViaLdd(libmpvPath: string): string[] {
  try {
    const output = execFileSync('ldd', [libmpvPath], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // 解析 ldd 输出：建立 SONAME → 实际路径 的映射
    // 输出格式示例：
    //   libavcodec.so.62 => /usr/lib/libavcodec.so.62 (0x00007f...)
    //   libavformat.so.62 => /usr/lib/libavformat.so.62 (0x00007f...)
    const depMap = new Map<string, string>();
    for (const line of output.split('\n')) {
      const m = line.match(/^\s*(\S+\.so[\d.]*)\s+=>\s+(\/\S+)/);
      if (m) depMap.set(m[1], m[2]);
    }

    // 按 PRELOAD_LIB_PATTERNS 的顺序输出，保持正确的依赖加载顺序
    // libavutil 应在 libavcodec 之前加载，这是 ldd 不保证的
    const libs: string[] = [];
    const seen = new Set<string>();
    for (const pattern of PRELOAD_LIB_PATTERNS) {
      const baseName = pattern.replace('.*', '');
      // 在 ldd 输出中找 SONAME 以 baseName 开头的库
      for (const [soname, resolvedPath] of depMap) {
        if (!soname.startsWith(baseName)) continue;
        if (seen.has(resolvedPath)) continue;
        seen.add(resolvedPath);
        libs.push(resolvedPath);
        break; // 每个 pattern 只取第一个匹配
      }
    }
    return libs;
  } catch {
    // ldd 不可用 / 非动态库 / 不存在 → 调用者回退
    return [];
  }
}

/**
 * 构建需要 LD_PRELOAD 的库列表。
 *
 * 优先策略：通过 ldd 查询 libmpv 实际依赖的 libav* 路径（精确匹配）。
 * 回退策略：当 ldd 不可用或失败时，扫描目录按名称匹配查找。
 */
function buildPreloadList(libDir: string): string[] {
  // ---- 优先策略：ldd 精确查询 ----
  // 当系统存在多套 FFmpeg（如 ffmpeg4.4 和 ffmpeg 8.1 共存）时，
  // 目录扫描排序可能选错版本。ldd 直接查询运行时链接路径，精确可靠。
  const libmpvPath = findLibmpvInDir(libDir);
  if (libmpvPath) {
    const lddLibs = getLibAvDepsViaLdd(libmpvPath);
    // ldd 至少命中核心库（libavformat + libavcodec + libavutil 等 ≥ 3 个）
    // 才认为结果可用。少于 3 个说明 ldd 输出可能不完整，回退目录扫描。
    if (lddLibs.length >= 3) {
      return lddLibs;
    }
  }

  // ---- 回退策略：目录扫描 ----
  // 兼容无 ldd 命令、libmpv 非动态链接、或 ldd 输出异常的场景
  let dirEntries: string[];
  try {
    dirEntries = fs.readdirSync(libDir);
  } catch {
    return [];
  }

  const libs: string[] = [];
  for (const pattern of PRELOAD_LIB_PATTERNS) {
    const found = findVersionedLib(libDir, dirEntries, pattern);
    if (found) libs.push(found);
  }
  return libs;
}

/**
 * 检查并修复 Linux 下 libmpv 的运行环境。
 * 必须在 app.ready 之前调用。
 *
 * @returns true 表示环境正常可继续启动，false 表示已触发 relaunch（当前进程应退出）
 */
export function ensureLinuxMpvEnv(): boolean {
  if (process.platform !== 'linux') return true;

  // 已经修复过，不再重复
  if (process.env[RELAUNCH_FLAG] === '1') return true;

  // 开发环境下跳过自动 relaunch（开发者可手动设置 LD_PRELOAD）
  if (!app.isPackaged) return true;

  // 查找系统 libmpv
  const libmpvDir = findSystemLibmpvDir();
  if (!libmpvDir) {
    // 没有系统 libmpv，无需处理（后续会回退到打包的库或报错）
    return true;
  }

  // 检查当前 LD_PRELOAD 是否已包含 libav*
  const currentPreload = process.env.LD_PRELOAD || '';
  if (currentPreload.includes('libavcodec.so') && currentPreload.includes('libavformat.so')) {
    // 已经正确设置（可能由 wrapper 脚本完成）
    process.env[RELAUNCH_FLAG] = '1';
    return true;
  }

  // 构建预加载列表
  const preloadLibs = buildPreloadList(libmpvDir);
  if (preloadLibs.length === 0) {
    // 找不到 libav* 库，无法修复
    return true;
  }

  // 设置环境变量并 relaunch
  const newPreload = preloadLibs.join(':') + (currentPreload ? ':' + currentPreload : '');
  const newLdPath =
    libmpvDir + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');

  process.env.LD_PRELOAD = newPreload;
  process.env.LD_LIBRARY_PATH = newLdPath;
  process.env[RELAUNCH_FLAG] = '1';

  // AppImage 环境下 app.relaunch() 有已知问题（electron-builder#1727），
  // 需要使用 APPIMAGE 环境变量指定正确的可执行路径
  const appImagePath = process.env.APPIMAGE;
  if (appImagePath) {
    app.relaunch({ execPath: appImagePath, args: process.argv.slice(1) });
  } else {
    app.relaunch();
  }
  app.exit(0);

  return false;
}
