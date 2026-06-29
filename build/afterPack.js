// electron-builder afterPack 钩子
// Linux 平台：将真正的 Electron 可执行文件重命名，用 wrapper 脚本替代入口。
// wrapper 在 Electron 启动前 source 共享的 linux-libmpv-env.sh，
// 通过 LD_PRELOAD 预加载系统完整版 libav*，解决与 Electron libffmpeg 的符号冲突。

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
  const helperSource = path.join(__dirname, 'linux-libmpv-env.sh');
  const helperTarget = path.join(appDir, 'resources', 'linux-libmpv-env.sh');

  // 确认原始可执行文件存在
  if (!fs.existsSync(originalBin)) {
    console.warn(`[afterPack] Original binary not found: ${originalBin}`);
    return;
  }

  if (!fs.existsSync(helperSource)) {
    console.warn(`[afterPack] Linux libmpv helper not found: ${helperSource}`);
    return;
  }

  // 重命名原始可执行文件
  fs.renameSync(originalBin, renamedBin);
  fs.mkdirSync(path.dirname(helperTarget), { recursive: true });
  fs.copyFileSync(helperSource, helperTarget);
  fs.chmodSync(helperTarget, 0o755);

  // 生成 wrapper 脚本
  // 核心策略：用 LD_PRELOAD 预加载系统完整版 libav*
  // LD_PRELOAD 优先级高于 RPATH 和 LD_LIBRARY_PATH，
  // 确保 libmpv 的符号解析到完整版而非 Electron 裁剪版。
  const wrapperContent = `#!/bin/bash
# EchoMusic Linux 启动 wrapper
# 解决 Electron 内置裁剪版 libffmpeg 与系统 libmpv 依赖的完整版 libav* 符号冲突。
# 策略：通过 LD_PRELOAD 预加载系统完整版 libav*，优先级高于 Electron 的 libffmpeg.so。

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
HELPER="$SCRIPT_DIR/resources/linux-libmpv-env.sh"

if [ -r "$HELPER" ]; then
    # shellcheck source=/dev/null
    . "$HELPER"
fi

# 启动真正的 Electron 主程序
exec "$SCRIPT_DIR/${executableName}-bin" "$@"
`;

  fs.writeFileSync(originalBin, wrapperContent, { mode: 0o755 });
  console.log(`[afterPack] Linux wrapper installed: ${originalBin} -> ${renamedBin}`);
};
