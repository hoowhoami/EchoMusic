import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "../../");
const webRoot = resolve(__dirname, "../");

try {
	execSync(
		"cargo build --package ffmpeg_wasm --target wasm32-unknown-emscripten --release",
		{
			cwd: projectRoot,
			stdio: "inherit",
		},
	);
} catch {
	process.exit(1);
}

const ffmpegOutDir = resolve(webRoot, "src/audio-core/worker/wasm");
if (!existsSync(ffmpegOutDir)) {
	mkdirSync(ffmpegOutDir, { recursive: true });
}

const ffmpegFiles = ["ffmpeg_wasm.js", "ffmpeg_wasm.wasm"];
const ffmpegReleaseDir = resolve(
	projectRoot,
	"target/wasm32-unknown-emscripten/release",
);

for (const file of ffmpegFiles) {
	const src = resolve(ffmpegReleaseDir, file);
	const dest = resolve(ffmpegOutDir, file);

	if (existsSync(src)) {
		copyFileSync(src, dest);
		console.log(`  ✅ Copied: ${file}`);
	} else {
		console.error(`  ⚠️ File not found: ${src}`);
		process.exit(1);
	}
}

const stCrateDir = resolve(projectRoot, "crates/soundtouch");

try {
	execSync(`wasm-pack build ${stCrateDir} --target web --release`, {
		cwd: projectRoot,
		stdio: "inherit",
	});
} catch {
	process.exit(1);
}

const stOutDir = resolve(webRoot, "src/audio-core/worklet/wasm");
if (!existsSync(stOutDir)) {
	mkdirSync(stOutDir, { recursive: true });
}

const stFiles = ["soundtouch.js", "soundtouch_bg.wasm", "soundtouch.d.ts"];
const stPkgDir = resolve(stCrateDir, "pkg");

for (const file of stFiles) {
	const src = resolve(stPkgDir, file);
	const dest = resolve(stOutDir, file);

	if (existsSync(src)) {
		copyFileSync(src, dest);
		console.log(`  ✅ Copied: ${file}`);
	} else {
		console.error(`  ⚠️ File not found: ${src}`);
		process.exit(1);
	}
}
