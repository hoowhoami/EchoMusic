// electron-builder afterPack 钩子
// Linux 平台：将真正的 Electron 可执行文件重命名，用 wrapper 脚本替代入口，
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

  // 确认原始可执行文件存在
  if (!fs.existsSync(originalBin)) {
    console.warn(`[afterPack] Original binary not found: ${originalBin}`);
    return;
  }

  // 重命名原始可执行文件
  fs.renameSync(originalBin, renamedBin);

  // 生成 wrapper 脚本
  // 核心策略：用 LD_PRELOAD 预加载系统完整版 libav*
  // LD_PRELOAD 优先级高于 RPATH 和 LD_LIBRARY_PATH，
  // 确保 libmpv 的符号解析到完整版而非 Electron 裁剪版。
  const wrapperContent = `#!/bin/bash
# EchoMusic Linux 启动 wrapper
# 解决 Electron 内置裁剪版 libffmpeg 与系统 libmpv 依赖的完整版 libav* 符号冲突。
# 策略：通过 LD_PRELOAD 预加载系统完整版 libav*，优先级高于 Electron 的 libffmpeg.so。

SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"

# 查找系统库目录（libmpv 和 libav* 通常在同一目录）
find_lib_dir() {
    local search_paths=(
        "/usr/lib/x86_64-linux-gnu"  # Debian/Ubuntu x64
        "/usr/lib/aarch64-linux-gnu" # Debian/Ubuntu arm64
        "/usr/lib/i386-linux-gnu"    # Debian/Ubuntu i386
        "/usr/lib64"                 # Fedora/RHEL/openSUSE x64
        "/usr/lib"                   # Arch/Manjaro/NixOS
        "/usr/local/lib"             # 手动编译
        "/usr/local/lib64"
    )
    for dir in "\${search_paths[@]}"; do
        if [ -f "$dir/libmpv.so.2" ] || [ -f "$dir/libmpv.so.1" ] || [ -f "$dir/libmpv.so" ]; then
            echo "$dir"
            return 0
        fi
    done
    # 回退：通过 ldconfig 查询（覆盖 NixOS 等非标准路径）
    local ldconfig_path
    ldconfig_path=$(ldconfig -p 2>/dev/null | grep "libmpv.so" | head -1 | sed 's/.*=> //')
    if [ -n "$ldconfig_path" ] && [ -f "$ldconfig_path" ]; then
        dirname "$ldconfig_path"
        return 0
    fi
    return 1
}

# 在目录中查找 so 文件（优先主版本号链接，如 libavcodec.so.61）
find_lib() {
    local dir="$1"
    local base="$2"
    # 先找带版本号的（如 libavcodec.so.61）
    local found
    found=$(find "$dir" -maxdepth 1 \\( -name "\${base}[0-9]*" \\) \\( -type f -o -type l \\) 2>/dev/null | sort | head -1)
    if [ -n "$found" ]; then
        echo "$found"
        return 0
    fi
    # 回退到无版本号的 .so（开发链接）
    if [ -f "$dir/\${base%.}" ] || [ -L "$dir/\${base%.}" ]; then
        echo "$dir/\${base%.}"
        return 0
    fi
    return 1
}

# 构建 LD_PRELOAD 列表
LIB_DIR=$(find_lib_dir)
if [ -n "$LIB_DIR" ]; then
    PRELOAD_LIBS=""
    # 按依赖顺序预加载（被依赖的在前）
    for lib in libavutil.so. libswresample.so. libavcodec.so. libavformat.so. libswscale.so. libavfilter.so.; do
        found=$(find_lib "$LIB_DIR" "$lib")
        if [ -z "$found" ]; then
            # libav* 可能不在 libmpv 同目录（NixOS 等），通过 ldconfig 查找
            found=$(ldconfig -p 2>/dev/null | grep "\${lib%.}" | grep -v "=>" | head -1 | sed 's/.*=> //' || true)
            if [ -z "$found" ]; then
                found=$(ldconfig -p 2>/dev/null | grep "\${lib}" | head -1 | sed 's/.*=> //' || true)
            fi
        fi
        if [ -n "$found" ] && [ -f "$found" ]; then
            PRELOAD_LIBS="\${PRELOAD_LIBS:+\$PRELOAD_LIBS:}$found"
        fi
    done

    if [ -n "$PRELOAD_LIBS" ]; then
        export LD_PRELOAD="\${PRELOAD_LIBS}\${LD_PRELOAD:+:\$LD_PRELOAD}"
    fi

    # 同时设置 LD_LIBRARY_PATH 作为后备
    export LD_LIBRARY_PATH="\${LIB_DIR}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
fi

# 标记环境已修复
export ECHO_MUSIC_LIBMPV_ENV_FIXED=1

# 启动真正的 Electron 主程序
exec "$SCRIPT_DIR/${executableName}-bin" "$@"
`;

  fs.writeFileSync(originalBin, wrapperContent, { mode: 0o755 });
  console.log(`[afterPack] Linux wrapper installed: ${originalBin} -> ${renamedBin}`);
};
