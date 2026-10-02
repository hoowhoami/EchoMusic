import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO = "apoint123/ffmpeg-audio";
export const ROOT = resolve(import.meta.dirname, "../..");

export interface PublishedCrate {
	name: string;
	dir: string;
}

// 发布到 crates.io 的 crate，按依赖顺序排列：被依赖的 sys 在前
export const PUBLISHED_CRATES: PublishedCrate[] = [
	{ name: "ffmpeg_audio_sys", dir: "crates/ffmpeg_audio_sys" },
	{ name: "ffmpeg_audio", dir: "crates/ffmpeg_audio" },
];

export function findCrate(name: string): PublishedCrate {
	const crate = PUBLISHED_CRATES.find((c) => c.name === name);
	if (!crate) {
		throw new Error(`未知的 crate: ${name}`);
	}
	return crate;
}

// changesets 维护的版本号，保存在 crate 目录下的 package.json 中
export function readPackageVersion(crate: PublishedCrate): string {
	const path = resolve(ROOT, crate.dir, "package.json");
	return JSON.parse(readFileSync(path, "utf-8")).version;
}

export const CARGO_VERSION_PATTERN = /^version = "([^"]*)"/m;

export function readCargoVersion(content: string): string | undefined {
	return CARGO_VERSION_PATTERN.exec(content)?.[1];
}

export function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: ROOT,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function lines(output: string): string[] {
	return output.split("\n").filter((line) => line !== "");
}
