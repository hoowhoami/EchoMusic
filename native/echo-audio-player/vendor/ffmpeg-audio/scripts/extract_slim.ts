import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { globSync } from "tinyglobby";

const ffmpegSrc = "ffmpeg";
const slimDst = "ffmpeg_slim";
const configsDir = "configs";

function toPosix(p: string): string {
	return p.replace(/\\/g, "/");
}

function copyFileSafe(src: string, dst: string) {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.copyFileSync(src, dst);
}

function parseLog(logPath: string): {
	cFiles: Set<string>;
	includeDirs: Set<string>;
} {
	const cFiles = new Set<string>();
	const includeDirs = new Set<string>();

	let content: string;
	try {
		content = fs.readFileSync(logPath, "utf-8");
	} catch (e) {
		console.error(`无法读取日志: ${logPath}`, e);
		return { cFiles, includeDirs };
	}

	for (const line of content.split(/\r?\n/)) {
		if (
			(!line.includes("-c -o ") && !line.includes("-c -Fo")) ||
			!line.includes(".c")
		) {
			continue;
		}
		const parts = line.split(/\s+/);
		for (const part of parts) {
			// 提取 -I 头文件搜索路径
			if (part.startsWith("-I")) {
				const inc = part.substring(2);
				if (inc === "." || inc === "") continue;

				// 找到路径中 ffmpeg/ 之后的部分
				for (const sep of ["ffmpeg/", "ffmpeg\\"]) {
					const idx = inc.indexOf(sep);
					if (idx !== -1) {
						const rel = inc.substring(idx + sep.length);
						if (rel) {
							includeDirs.add(toPosix(rel));
						}
						break;
					}
				}
			} else if (part.endsWith(".c")) {
				// 提取 .c 源文件路径
				for (const marker of ["libav", "libsw", "compat/"]) {
					const idx = part.indexOf(marker);
					if (idx !== -1) {
						cFiles.add(toPosix(part.substring(idx)));
						break;
					}
				}
			}
		}
	}

	return { cFiles, includeDirs };
}

if (!fs.existsSync(ffmpegSrc)) {
	console.error("错误：ffmpeg/ 目录不存在");
	process.exit(1);
}

if (fs.existsSync(slimDst)) {
	console.log(`清理旧的 ${slimDst}/ ...`);
	fs.rmSync(slimDst, { recursive: true, force: true });
}
fs.mkdirSync(slimDst, { recursive: true });

// ── 1. 解析所有平台日志 ──────────────────────────────────────────────
const allCFiles = new Set<string>();
const allIncludeDirs = new Set<string>();

if (fs.existsSync(configsDir)) {
	for (const entry of fs.readdirSync(configsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const logPath = path.join(configsDir, entry.name, "make_dryrun.log");
		if (!fs.existsSync(logPath)) continue;

		const { cFiles, includeDirs } = parseLog(logPath);
		cFiles.forEach((f) => {
			allCFiles.add(f);
		});
		includeDirs.forEach((d) => {
			allIncludeDirs.add(d);
		});
		console.log(
			`  ${entry.name}: ${cFiles.size} C 文件, ${includeDirs.size} -I 路径`,
		);
	}
}

console.log(
	`\n合并后：${allCFiles.size} 个唯一 C 文件，${allIncludeDirs.size} 个唯一 -I 路径`,
);
console.log("额外 -I 路径（compat 等）：");
Array.from(allIncludeDirs)
	.sort()
	.forEach((d) => {
		console.log(`  ${d}`);
	});

// ── 2. 复制 C 源文件 ─────────────────────────────────────────────────
console.log("\n复制 C 源文件...");
let cOk = 0;
let cMiss = 0;

function copyCFile(relStr: string): string | null {
	const raw = path.join(ffmpegSrc, relStr);
	const resolved = path.normalize(raw);

	let relToSrc = "";
	if (resolved.startsWith(path.normalize(ffmpegSrc))) {
		relToSrc = path.relative(path.normalize(ffmpegSrc), resolved);
	} else {
		relToSrc = path.normalize(relStr);
	}

	const dst = path.join(slimDst, relToSrc);
	if (fs.existsSync(resolved)) {
		copyFileSafe(resolved, dst);
		return dst;
	}
	return null;
}

for (const relStr of Array.from(allCFiles).sort()) {
	const dst = copyCFile(relStr);
	if (dst) {
		cOk++;
	} else {
		console.log(`  !! 缺失: ${path.join(ffmpegSrc, relStr)}`);
		cMiss++;
	}
}
console.log(`  成功: ${cOk}  缺失: ${cMiss}`);

// ── 2b. 递归处理 #include "*.c" 模式 ─────────────────────────────────
// FFmpeg 中大量使用模板文件（如 resample_template.c），这些文件通过
// include 被其他 C 文件引入，不会出现在 make_dryrun.log 里，需要额外复制
console.log("\n查找并复制被 #include 的 .c 模板文件...");
const includeCPattern = /#include\s+"([^"]+\.c)"/g;
let extraCopied = 0;
let rounds = 0;

while (true) {
	rounds++;
	const newlyNeeded = new Set<string>();

	const cFiles = globSync("**/*.c", { cwd: slimDst, absolute: true });
	for (const filePath of cFiles) {
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			for (const match of content.matchAll(includeCPattern)) {
				const included = match[1];
				const candidate = path.normalize(
					path.join(path.dirname(filePath), included),
				);

				try {
					const relToSlimDst = path.relative(
						path.normalize(slimDst),
						candidate,
					);
					const srcCandidate = path.join(ffmpegSrc, relToSlimDst);
					const dstCandidate = path.join(slimDst, relToSlimDst);

					if (!fs.existsSync(dstCandidate) && fs.existsSync(srcCandidate)) {
						newlyNeeded.add(toPosix(relToSlimDst));
					}
				} catch (e) {
					console.error("解析目录时出错", e);
				}
			}
		} catch (e) {
			console.error("无法读取文件", e);
		}
	}

	if (newlyNeeded.size === 0) {
		console.log(`  共经过 ${rounds} 轮扫描，无新增依赖`);
		break;
	}

	for (const relStr of Array.from(newlyNeeded).sort()) {
		const dst = copyCFile(relStr);
		if (dst) {
			extraCopied++;
		} else {
			console.log(
				`  !! 被 include 的 C 文件缺失: ${path.join(ffmpegSrc, relStr)}`,
			);
		}
	}
}
console.log(`  额外复制了 ${extraCopied} 个被 #include 的 C 模板文件`);

// ── 3. 复制头文件 ────────────────────────────────────────────────────
// 收集所有需要扫描的目录（相对于 ffmpeg/）
const hScanRoots = new Set<string>();

// 标准 lib 目录（总是需要）
["libavcodec", "libavformat", "libavutil", "libswresample"].forEach((lib) => {
	hScanRoots.add(lib);
});

// compat 全树（包含 atomics/win32、stdbit 等）
hScanRoots.add("compat");

// 日志中出现的额外 -I 目录
allIncludeDirs.forEach((incRel) => {
	const top = toPosix(incRel).split("/")[0];
	if (top) hScanRoots.add(top);
});

// ffmpeg/ 根目录下可能有少量 .h（如 libcompat）
hScanRoots.add("");

console.log("\n复制头文件...");
let hOk = 0;
const scanned = new Set<string>();

for (const rootRel of Array.from(hScanRoots).sort()) {
	const srcDir = rootRel ? path.join(ffmpegSrc, rootRel) : ffmpegSrc;
	if (!fs.existsSync(srcDir) || scanned.has(rootRel)) continue;
	scanned.add(rootRel);

	const hFiles = globSync("**/*.h", { cwd: srcDir, absolute: true });
	for (const filePath of hFiles) {
		try {
			const relToSrc = path.relative(
				path.normalize(ffmpegSrc),
				path.normalize(filePath),
			);
			const dst = path.join(slimDst, relToSrc);
			copyFileSafe(filePath, dst);
			hOk++;
		} catch (_e) {
			// 忽略异常文件
		}
	}
}
console.log(`  成功: ${hOk} 个头文件`);

// ── 4. 汇总 ─────────────────────────────────────────────────────────
let totalSlimFiles = 0;
let totalSlimBytes = 0;
const slimFiles = globSync("**/*", { cwd: slimDst, absolute: true });
for (const filePath of slimFiles) {
	totalSlimFiles++;
	totalSlimBytes += fs.statSync(filePath).size;
}
console.log(`\nffmpeg_slim/ 生成完毕`);
console.log(`   文件总数: ${totalSlimFiles}`);
console.log(`   磁盘占用: ${(totalSlimBytes / 1_048_576).toFixed(1)} MB`);

// ── 5. 辅助函数：生成 ZIP ──────────────────────────────────────────
// 条目路径格式：libavcodec/foo.c（不含 ffmpeg_slim/ 前缀）
// 解压到 OUT_DIR/ffmpeg_slim/ 后得到 OUT_DIR/ffmpeg_slim/libavcodec/foo.c
async function createZip(sourceDir: string, destZipPath: string) {
	fs.mkdirSync(path.dirname(destZipPath), { recursive: true });
	console.log(`\n打包 ${destZipPath} ...`);
	const zip = new JSZip();

	const files = globSync("**/*", { cwd: sourceDir });
	for (const file of files) {
		const fullPath = path.join(sourceDir, file);
		const fileData = fs.readFileSync(fullPath);
		zip.file(file, fileData);
	}

	const zipData = await zip.generateAsync({
		type: "uint8array",
		compression: "DEFLATE",
		compressionOptions: { level: 9 },
	});

	fs.writeFileSync(destZipPath, zipData);
	const sizeMb = zipData.length / 1_048_576;
	console.log(`  ${destZipPath}：${sizeMb.toFixed(1)} MB`);
}

// ── 6. 打包 vendor/ffmpeg_slim.zip 和 vendor/configs.zip ─────────
// 条目路径格式：build_out_xxx/config.h（不含 configs/ 前缀）
// 解压到 OUT_DIR/configs/ 后得到 OUT_DIR/configs/build_out_xxx/config.h
fs.mkdirSync(path.join("crates", "ffmpeg_audio_sys", "vendor"), {
	recursive: true,
});

await createZip(
	slimDst,
	path.join("crates", "ffmpeg_audio_sys", "vendor", "ffmpeg_slim.zip"),
);
await createZip(
	configsDir,
	path.join("crates", "ffmpeg_audio_sys", "vendor", "configs.zip"),
);

console.log("\n✅ 完成！ffmpeg_slim.zip 和 configs.zip 已生成");
