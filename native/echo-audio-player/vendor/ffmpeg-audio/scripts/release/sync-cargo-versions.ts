// 把 changesets 维护的版本号（crate 目录下的 package.json）同步到 Cargo.toml，
// 同时把 ffmpeg_audio 对 ffmpeg_audio_sys 的依赖声明改成 sys 的当前版本。
// 传入 --check 时只检查、不写入，版本不一致则以非零状态退出。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	CARGO_VERSION_PATTERN,
	findCrate,
	PUBLISHED_CRATES,
	ROOT,
	readPackageVersion,
} from "./crates.ts";

const SYS_DEPENDENCY_PATTERN =
	/^(ffmpeg_audio_sys = \{[^}\n]*\bversion = ")[^"]*(")/m;

function replaceOnce(
	content: string,
	pattern: RegExp,
	replacement: string,
	path: string,
): string {
	if (!pattern.test(content)) {
		throw new Error(`${path} 中找不到 ${pattern}，Cargo.toml 的格式可能变了`);
	}
	return content.replace(pattern, replacement);
}

const check = process.argv.includes("--check");
const sysVersion = readPackageVersion(findCrate("ffmpeg_audio_sys"));
const outOfSync: string[] = [];

for (const crate of PUBLISHED_CRATES) {
	const path = resolve(ROOT, crate.dir, "Cargo.toml");
	const original = readFileSync(path, "utf-8");

	let updated = replaceOnce(
		original,
		CARGO_VERSION_PATTERN,
		`version = "${readPackageVersion(crate)}"`,
		path,
	);
	if (crate.name === "ffmpeg_audio") {
		updated = replaceOnce(
			updated,
			SYS_DEPENDENCY_PATTERN,
			`$1${sysVersion}$2`,
			path,
		);
	}

	if (updated === original) {
		continue;
	}
	if (check) {
		outOfSync.push(`${crate.dir}/Cargo.toml`);
	} else {
		writeFileSync(path, updated);
		console.log(`已同步 ${crate.dir}/Cargo.toml`);
	}
}

if (outOfSync.length > 0) {
	console.error(
		`以下文件的版本号与同目录 package.json 不一致: ${outOfSync.join(", ")}`,
	);
	console.error(
		"版本号由 changesets 管理，请运行 node scripts/release/sync-cargo-versions.ts 同步",
	);
	process.exit(1);
}
