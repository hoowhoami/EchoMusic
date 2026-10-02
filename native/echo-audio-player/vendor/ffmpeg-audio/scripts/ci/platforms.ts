// CI 的 target 矩阵，以及 `main` 上每次提交实际运行的代表性子集。
//
// 判定与选择逻辑在 select-platforms.ts，事件到矩阵的映射见 ci.yml 的 `full` 判定：
// PR 与发版前跑这里的完整列表，`main` 上的普通提交只跑 PUSH_PLATFORMS。
// 新增 target 时只需要在这里加一条；要把它放进常驻子集，再加进 PUSH_PLATFORMS。
//
// 注意：这里的列表必须与 crates/ffmpeg_audio_sys/build.rs 的 get_config_dir_name()
// 以及 crates/ffmpeg_audio_sys/vendor/configs.zip 里的配置目录保持一致。

export interface Platform {
	/** Rust target triple，同时用作矩阵条目的名字与 rust-cache 的 key。 */
	target: string;
	/** GitHub 托管 runner 标签。 */
	os: string;
	/** 传给 msvc-dev-cmd 的 MSVC 架构，非 MSVC target 不设。 */
	msvc_arch?: string;
	/** 除 libasound2-dev 外额外安装的 apt 包。 */
	apt_packages?: string;
	/** 用 `cross` 在容器里构建（Android）。 */
	cross?: true;
	/** 只跑 `cargo check --workspace`。 */
	check_only?: true;
	/** 只跑 `cargo check -p ffmpeg_audio_sys`。 */
	check_sys_only?: true;
	/** 构建前安装 emsdk。 */
	emscripten?: true;
	/** 构建前下载 LLVM-MinGW。 */
	llvm_mingw?: true;
}

export const ALL_PLATFORMS: readonly Platform[] = [
	// Windows MSVC
	{ target: "x86_64-pc-windows-msvc", os: "windows-latest" },
	{
		target: "i686-pc-windows-msvc",
		os: "windows-latest",
		msvc_arch: "x86",
		check_only: true,
	},
	{
		target: "aarch64-pc-windows-msvc",
		os: "windows-latest",
		msvc_arch: "amd64_arm64",
		check_only: true,
	},

	// Windows GNU
	{
		target: "x86_64-pc-windows-gnu",
		os: "ubuntu-latest",
		apt_packages: "mingw-w64",
		check_only: true,
	},
	{
		target: "aarch64-pc-windows-gnullvm",
		os: "ubuntu-latest",
		llvm_mingw: true,
		check_only: true,
	},

	// macOS
	{ target: "x86_64-apple-darwin", os: "macos-latest" },
	{ target: "aarch64-apple-darwin", os: "macos-latest" },

	// Linux GNU
	{ target: "x86_64-unknown-linux-gnu", os: "ubuntu-latest" },
	{
		target: "aarch64-unknown-linux-gnu",
		os: "ubuntu-latest",
		apt_packages: "gcc-aarch64-linux-gnu libclang-dev",
		check_only: true,
	},
	{
		target: "i686-unknown-linux-gnu",
		os: "ubuntu-latest",
		apt_packages: "gcc-multilib libc6-dev-i386 libclang-dev",
		check_sys_only: true,
	},
	{
		target: "armv7-unknown-linux-gnueabihf",
		os: "ubuntu-latest",
		apt_packages: "gcc-arm-linux-gnueabihf libc6-dev-armhf-cross libclang-dev",
		check_only: true,
	},

	// Android
	{ target: "aarch64-linux-android", os: "ubuntu-latest", cross: true },
	{ target: "armv7-linux-androideabi", os: "ubuntu-latest", cross: true },
	{ target: "i686-linux-android", os: "ubuntu-latest", cross: true },
	{ target: "x86_64-linux-android", os: "ubuntu-latest", cross: true },

	// iOS
	{ target: "aarch64-apple-ios", os: "macos-latest", check_only: true },

	// WASM
	{
		target: "wasm32-unknown-emscripten",
		os: "ubuntu-latest",
		emscripten: true,
	},
];

/**
 * `main` 上每次提交运行的常驻子集。
 *
 * 选条目的口径是「用最少的条目覆盖最多的编译器家族与 ABI 差异」，而不是「最常用的平台」：
 * MSVC、Apple Clang（含 ARM64）、GNU GCC、Emscripten、NDK Clang 各留一个，
 * 加上 Android 与 iOS 这两条与桌面差异最大的链路。其余平台（Windows GNU、x86/armv7、
 * Android 其余 ABI 等）只在完整矩阵里验证。
 */
export const PUSH_PLATFORMS: readonly string[] = [
	"x86_64-pc-windows-msvc", // MSVC
	"x86_64-unknown-linux-gnu", // GNU GCC
	"aarch64-apple-darwin", // Apple Clang + ARM64
	"wasm32-unknown-emscripten", // Emscripten
	"aarch64-unknown-linux-gnu", // GCC + ARM64
	"aarch64-linux-android", // NDK Clang + cross
	"aarch64-apple-ios", // Apple 移动端 SDK
];
