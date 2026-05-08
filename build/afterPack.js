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
    '# 查找系统 libmpv 所在目录',
    'find_libmpv_dir() {',
    '    local search_paths=(',
    '        "/usr/lib/x86_64-linux-gnu"',
    '        "/usr/lib/aarch64-linux-gnu"',
    '        "/usr/lib"',
    '        "/usr/local/lib"',
    '    )',
    '    for dir in "${search_paths[@]}"; do',
    '        if [ -f "$dir/libmpv.so" ] || [ -f "$dir/libmpv.so.2" ] || [ -f "$dir/libmpv.so.1" ]; then',
    '            echo "$dir"',
    '            return 0',
    '        fi',
    '    done',
    '    return 1',
    '}',
    '',
    '# 在指定目录中查找匹配 pattern 的第一个文件',
    'find_lib() {',
    '    local dir="$1"',
    '    shift',
    '    for pattern in "$@"; do',
    '        local found=$(ls "$dir"/$pattern 2>/dev/null | head -1)',
    '        if [ -n "$found" ]; then',
    '            echo "$found"',
    '            return 0',
    '        fi',
    '    done',
    '    return 1',
    '}',
    '',
    '# 如果找到系统 libmpv，预加载其依赖的 libav* 库',
    'LIBMPV_DIR=$(find_libmpv_dir)',
    'if [ -n "$LIBMPV_DIR" ]; then',
    '    PRELOAD_LIBS=""',
    '    for lib in libavutil.so* libswresample.so* libavcodec.so* libavformat.so* libswscale.so* libavfilter.so*; do',
    '        found=$(ls "$LIBMPV_DIR"/$lib 2>/dev/null | grep -v "\\.so$" | head -1)',
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
    `# 启动真正的 Electron 主程序`,
    `exec "$SCRIPT_DIR/${executableName}-bin" "$@"`,
    '',
  ].join('\n');

  fs.writeFileSync(originalBin, wrapperContent, { mode: 0o755 });
  console.log(`[afterPack] Linux wrapper installed: ${originalBin} -> ${renamedBin}`);
};
