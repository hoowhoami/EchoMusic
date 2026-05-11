// electron-builder afterPack 钩子
// Linux 平台：将真正的 Electron 可执行文件重命名，用 wrapper 脚本替代入口，
// 确保启动时 LD_LIBRARY_PATH 正确设置，避免 libmpv 与 Electron libffmpeg 的符号冲突。

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (process.platform !== 'linux' && context.electronPlatformName !== 'linux') {
    return;
  }

  const appDir = context.appOutDir;
  const executableName = context.packager.executableName; // 'echo-music'

  const originalBin = path.join(appDir, executableName);
  const renamedBin = path.join(appDir, `${executableName}-bin`);

  // 确认原始可执行文件存在
  if (!fs.existsSync(originalBin)) {
    console.warn(`[afterPack] Original binary not found: ${originalBin}`);
    return;
  }

  // 重命名原始可执行文件
  fs.renameSync(originalBin, renamedBin);

  // 生成 wrapper 脚本
  const wrapperContent = [
    '#!/bin/bash',
    '# EchoMusic Linux 启动 wrapper',
    '# 解决 Electron 内置裁剪版 libffmpeg 与系统 libmpv 依赖的完整版 libav* 符号冲突问题。',
    '# 通过 LD_PRELOAD 在 Electron 启动前预加载系统完整版 libav*，',
    '# 确保 libmpv 的依赖绑定到完整版而非 Electron 的裁剪版。',
    '',
    'SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"',
    '',
    '# 查找系统 libmpv 所在目录（覆盖主流发行版）',
    'find_libmpv_dir() {',
    '    local search_paths=(',
    '        "/usr/lib/x86_64-linux-gnu"  # Debian/Ubuntu x64',
    '        "/usr/lib/aarch64-linux-gnu" # Debian/Ubuntu arm64',
    '        "/usr/lib/i386-linux-gnu"    # Debian/Ubuntu i386',
    '        "/usr/lib64"                 # Fedora/RHEL/openSUSE x64',
    '        "/usr/lib"                   # Arch/Manjaro/CachyOS',
    '        "/usr/local/lib"             # 手动编译安装',
    '        "/usr/local/lib64"',
    '    )',
    '    for dir in "${search_paths[@]}"; do',
    '        if [ -f "$dir/libmpv.so.2" ] || [ -f "$dir/libmpv.so.1" ] || [ -f "$dir/libmpv.so" ]; then',
    '            echo "$dir"',
    '            return 0',
    '        fi',
    '    done',
    '    return 1',
    '}',
    '',
    '# 在指定目录中查找带版本号的 so 文件（排除纯 .so 开发链接）',
    '# 优先选择最短文件名（主版本号，如 libavutil.so.60）',
    'find_versioned_lib() {',
    '    local dir="$1"',
    '    local basename="$2"',
    '    # 查找 basename 开头、带数字版本后缀的文件',
    '    local found=$(find "$dir" -maxdepth 1 -name "${basename}[0-9]*" -type f -o -name "${basename}[0-9]*" -type l 2>/dev/null | awk \'{ print length, $0 }\' | sort -n | head -1 | cut -d" " -f2-)',
    '    if [ -n "$found" ]; then',
    '        echo "$found"',
    '        return 0',
    '    fi',
    '    return 1',
    '}',
    '',
    '# 如果找到系统 libmpv，预加载其依赖的 libav* 库',
    'LIBMPV_DIR=$(find_libmpv_dir)',
    'if [ -n "$LIBMPV_DIR" ]; then',
    '    PRELOAD_LIBS=""',
    '    for lib in libavutil.so. libswresample.so. libavcodec.so. libavformat.so. libswscale.so. libavfilter.so.; do',
    '        found=$(find_versioned_lib "$LIBMPV_DIR" "$lib")',
    '        if [ -n "$found" ]; then',
    '            PRELOAD_LIBS="${PRELOAD_LIBS:+$PRELOAD_LIBS:}$found"',
    '        fi',
    '    done',
    '    if [ -n "$PRELOAD_LIBS" ]; then',
    '        export LD_PRELOAD="${PRELOAD_LIBS}${LD_PRELOAD:+:$LD_PRELOAD}"',
    '    fi',
    '    export LD_LIBRARY_PATH="${LIBMPV_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"',
    'fi',
    '',
    '# 标记环境已修复，避免主进程再次 relaunch',
    'export ECHO_MUSIC_LIBMPV_ENV_FIXED=1',
    '',
    `# 启动真正的 Electron 主程序`,
    `exec "$SCRIPT_DIR/${executableName}-bin" "$@"`,
    '',
  ].join('\n');

  fs.writeFileSync(originalBin, wrapperContent, { mode: 0o755 });
  console.log(`[afterPack] Linux wrapper installed: ${originalBin} -> ${renamedBin}`);
};
