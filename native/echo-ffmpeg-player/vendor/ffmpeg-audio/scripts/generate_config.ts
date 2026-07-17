import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.length < 2) {
	console.error("错误: 缺少参数");
	console.error(
		"用法: node generate_config.ts <windows|linux|android|macos|ios|emscripten> <x86_64|x86|aarch64|arm|armeabi-v7a|arm64-v8a|arm64|wasm32>",
	);
	process.exit(1);
}

const targetOs = args[0];
let targetArch = args[1];

console.log(`为 ${targetOs} (${targetArch}) 生成 FFmpeg 配置...`);

const options: string[] = [
	"--disable-everything",
	"--disable-programs",
	"--disable-network",
	"--disable-doc",
	"--enable-avcodec",
	"--enable-avformat",
	"--enable-avutil",
	"--enable-swresample",
	"--disable-avdevice",
	"--disable-avfilter",
	"--disable-swscale",
	"--enable-protocol=file",
	"--disable-autodetect",
	"--disable-asm",
	"--disable-x86asm",
	"--disable-inline-asm",
];

const demuxers = [
	"aac",
	"ac3",
	"aiff",
	"amr",
	"ape",
	"asf",
	"au",
	"caf",
	"dsf",
	"dts",
	"dtshd",
	"eac3",
	"flac",
	"iff",
	"m4v",
	"matroska",
	"mov",
	"mp3",
	"mpc",
	"mpc8",
	"ogg",
	"rm",
	"spdif",
	"tak",
	"truehd",
	"tta",
	"w64",
	"wav",
	"wv",
];

const decoders = [
	"aac",
	"aac_latm",
	"ac3",
	"adpcm_ima_wav",
	"adpcm_ms",
	"adpcm_swf",
	"alac",
	"als",
	"amrnb",
	"amrwb",
	"ape",
	"cook",
	"dca",
	"dsd_lsbf",
	"dsd_lsbf_planar",
	"dsd_msbf",
	"dsd_msbf_planar",
	"eac3",
	"flac",
	"mlp",
	"mp3",
	"mpc7",
	"mpc8",
	"opus",
	"pcm_alaw",
	"pcm_bluray",
	"pcm_dvd",
	"pcm_f32be",
	"pcm_f32le",
	"pcm_f64be",
	"pcm_f64le",
	"pcm_mulaw",
	"pcm_s16be",
	"pcm_s16le",
	"pcm_s24be",
	"pcm_s24le",
	"pcm_s32be",
	"pcm_s32le",
	"pcm_s8",
	"pcm_u16be",
	"pcm_u16le",
	"pcm_u24be",
	"pcm_u24le",
	"pcm_u32be",
	"pcm_u32le",
	"pcm_u8",
	"ra_144",
	"ra_288",
	"shorten",
	"tak",
	"truehd",
	"tta",
	"vorbis",
	"wavpack",
	"wmalossless",
	"wmapro",
	"wmav1",
	"wmav2",
	"wmavoice",
];

const parsers = [
	"aac",
	"aac_latm",
	"ac3",
	"amr",
	"cook",
	"dca",
	"flac",
	"mlp",
	"mpegaudio",
	"opus",
	"sipr",
	"tak",
	"vorbis",
	"wma",
];

options.push(`--enable-demuxer=${demuxers.join(",")}`);
options.push(`--enable-decoder=${decoders.join(",")}`);
options.push(`--enable-parser=${parsers.join(",")}`);

if (targetOs === "windows") {
	options.push("--toolchain=msvc");
	if (targetArch === "x86_64") {
		options.push("--target-os=win64", "--arch=x86_64");
	} else if (targetArch === "x86") {
		options.push("--target-os=win32", "--arch=i386");
	} else if (targetArch === "arm64" || targetArch === "aarch64") {
		options.push(
			"--target-os=win32",
			"--arch=aarch64",
			"--enable-cross-compile",
		);
		targetArch = "arm64";
	} else {
		console.error(`不支持的 Windows 架构: ${targetArch}`);
		process.exit(1);
	}
	options.push("--extra-cflags=-DHAVE_UNISTD_H=0");
} else if (targetOs === "windows-gnu") {
	options.push("--target-os=mingw32", "--enable-cross-compile");

	if (targetArch === "x86_64") {
		options.push("--arch=x86_64", "--cc=x86_64-w64-mingw32-clang");
	} else if (targetArch === "x86") {
		options.push("--arch=x86", "--cc=i686-w64-mingw32-clang");
	} else if (targetArch === "aarch64" || targetArch === "arm64") {
		options.push("--arch=aarch64", "--cc=aarch64-w64-mingw32-clang");
		targetArch = "aarch64";
	} else if (targetArch === "arm" || targetArch === "armv7") {
		options.push("--arch=arm", "--cc=armv7-w64-mingw32-clang");
		targetArch = "arm";
	} else {
		console.error(`不支持的 Windows GNU 架构: ${targetArch}`);
		process.exit(1);
	}
} else if (targetOs === "linux") {
	options.push("--target-os=linux");
	if (targetArch === "arm64" || targetArch === "aarch64") {
		options.push(
			"--arch=aarch64",
			"--enable-cross-compile",
			"--cc=aarch64-linux-gnu-gcc",
		);
		targetArch = "arm64";
	} else if (targetArch === "armv7") {
		options.push(
			"--arch=arm",
			"--enable-cross-compile",
			"--cc=arm-linux-gnueabihf-gcc",
		);
	} else if (targetArch === "x86") {
		options.push(
			"--arch=x86",
			"--enable-cross-compile",
			"--cc=i686-linux-gnu-gcc",
		);
	} else if (targetArch === "x86_64") {
		options.push(`--arch=${targetArch}`);
	} else {
		console.error(`不支持的 Linux 架构: ${targetArch}`);
		process.exit(1);
	}
} else if (targetOs === "android") {
	options.push("--target-os=android", "--enable-cross-compile");

	const ndkPath =
		process.env.ANDROID_NDK_LATEST_HOME || process.env.ANDROID_NDK_HOME;
	if (!ndkPath) {
		console.error("错误: 找不到环境变量 ANDROID_NDK_HOME");
		process.exit(1);
	}

	const toolchain = `${ndkPath}/toolchains/llvm/prebuilt/linux-x86_64/bin`;
	const api = 26;

	if (targetArch === "arm" || targetArch === "armeabi-v7a") {
		options.push("--arch=arm", "--cpu=armv7-a");
		options.push(`--cc=${toolchain}/armv7a-linux-androideabi${api}-clang`);
		targetArch = "armeabi-v7a";
	} else if (targetArch === "aarch64" || targetArch === "arm64-v8a") {
		options.push("--arch=aarch64");
		options.push(`--cc=${toolchain}/aarch64-linux-android${api}-clang`);
		targetArch = "arm64-v8a";
	} else if (targetArch === "x86") {
		options.push("--arch=x86", "--cpu=i686");
		options.push(`--cc=${toolchain}/i686-linux-android${api}-clang`);
		targetArch = "x86";
	} else if (targetArch === "x86_64") {
		options.push("--arch=x86_64");
		options.push(`--cc=${toolchain}/x86_64-linux-android${api}-clang`);
		targetArch = "x86_64";
	} else {
		console.error(`不支持的 Android 架构: ${targetArch}`);
		process.exit(1);
	}
} else if (targetOs === "macos") {
	options.push("--target-os=darwin");
	if (targetArch === "x86_64") {
		options.push("--arch=x86_64", "--enable-cross-compile");
		options.push("--extra-cflags=-arch x86_64", "--extra-ldflags=-arch x86_64");
		targetArch = "x86_64";
	} else if (targetArch === "arm64" || targetArch === "aarch64") {
		options.push("--arch=aarch64");
		targetArch = "arm64";
	} else {
		console.error(`不支持的 macOS 架构: ${targetArch}`);
		process.exit(1);
	}
} else if (targetOs === "ios") {
	options.push("--target-os=darwin", "--enable-cross-compile");
	if (targetArch === "arm64" || targetArch === "aarch64") {
		options.push("--arch=aarch64", "--cc=clang");

		const xcrunResult = spawnSync("xcrun", [
			"--sdk",
			"iphoneos",
			"--show-sdk-path",
		]);
		if (xcrunResult.error || xcrunResult.status !== 0) {
			console.error("错误: 无法获取 iOS SDK 路径");
			if (xcrunResult.stderr) {
				console.error(xcrunResult.stderr.toString());
			}
			process.exit(1);
		}
		const sysroot = xcrunResult.stdout.toString().trim();

		options.push(`--extra-cflags=-isysroot ${sysroot}`);
		options.push("--extra-cflags=-target aarch64-apple-ios12.0");
		options.push("--extra-cflags=-miphoneos-version-min=12.0");
		options.push(`--extra-ldflags=-isysroot ${sysroot}`);
		options.push("--extra-ldflags=-target aarch64-apple-ios12.0");

		targetArch = "arm64";
	} else {
		console.error(`不支持的 iOS 架构: ${targetArch}`);
		process.exit(1);
	}
} else if (targetOs === "emscripten") {
	options.push("--target-os=none", "--enable-cross-compile");

	// Disable multi-threading-related features only when targeting WASM.
	// FFmpeg's `avcodec.c` uses runtime `if` statements rather than preprocessor `#if` directives—for example:
	// https://github.com/FFmpeg/FFmpeg/blob/239f2c733de417201d7ad3b3b8b0d9b63285b2b1/libavcodec/avcodec.c#L325-L333
	// Under the `/Od` flag, MSVC does not perform constant folding; consequently, calls to multi-threading-related
	// symbols within these `if` statements are retained, resulting in linker errors.
	options.push(
		"--disable-pthreads",
		"--disable-w32threads",
		"--disable-os2threads",
	);
	if (targetArch === "wasm32") {
		options.push("--arch=wasm32");
		options.push("--cc=emcc");
		options.push("--ar=emar");
		options.push("--extra-cflags=-DARCH_WASM32=1");
		options.push("--extra-cflags=-msimd128");
	} else {
		console.error(`不支持的 Emscripten 架构: ${targetArch}`);
		process.exit(1);
	}
} else {
	console.error(`不支持的 OS: ${targetOs}`);
	process.exit(1);
}

const buildDir = `build_out_${targetOs}_${targetArch}`;
mkdirSync(buildDir, { recursive: true });
const safeOptions = options.map((opt) => `'${opt}'`).join(" ");

console.log("运行 Configure 命令:");
console.log(`../configure ${safeOptions}`);

const configureResult = spawnSync(
	"bash",
	["-c", `../configure ${safeOptions}`],
	{
		cwd: buildDir,
		stdio: "inherit",
	},
);

if (configureResult.status === 0) {
	console.log("Configure 成功，生成编译日志...");

	const makeResult = spawnSync(
		"bash",
		["-c", "make V=1 -n > make_dryrun.log"],
		{
			cwd: buildDir,
			stdio: "inherit",
		},
	);

	if (makeResult.status === 0) {
		console.log(`配置已输出至 : ${buildDir}/config.h`);
		console.log(`编译日志输出至: ${buildDir}/make_dryrun.log`);
	} else {
		console.error("生成编译日志 (make V=1 -n) 失败！");
		process.exit(1);
	}
} else {
	console.error("Configure 失败！请检查 ffbuild/config.log 报错");

	const configLogPath = join(buildDir, "ffbuild", "config.log");
	try {
		const configLog = readFileSync(configLogPath, "utf-8");
		const lines = configLog.split("\n");
		console.log("-------------------------------------------------");
		console.log(lines.slice(-500).join("\n"));
		console.log("-------------------------------------------------");
	} catch (_e) {
		console.error("未找到 ffbuild/config.log，无法打印错误信息");
	}

	process.exit(1);
}
