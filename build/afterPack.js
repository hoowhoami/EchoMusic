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
    '# 如果找到系统 libmpv，将其目录加入 LD_LIBRARY_PATH 最前面',
    'LIBMPV_DIR=$(find_libmpv_dir)',
    'if [ -n "$LIBMPV_DIR" ]; then',
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
