// 发版：找出本次 push 引入、但还没有 GitHub Release 的 crate 版本，
// 依次打包验证、上传到 crates.io、打 tag、创建 GitHub Release。
// 每一步都会先检查是否已经完成，所以失败后重新运行同一次 workflow 会从断点继续。
//
// 子命令按顺序在 .github/workflows/release.yml 中调用：
//   plan      计算待发布的版本，写入 GITHUB_OUTPUT 的 has-pending
//   package   对还没上传的 crate 运行 cargo package（完整编译验证），写入 GITHUB_OUTPUT 的 upload
//   upload    用 CARGO_REGISTRY_TOKEN 上传，跳过验证（package 已经做过）
//   finalize  打 tag 并创建 GitHub Release
//
// 只发布「由本次 push 引入」的版本（PUSH_BEFORE..HEAD 之间改动了 Cargo.toml 版本号的提交），
// 这样既不会把早已发布的旧版本打到错误的提交上，也不会在之后的 push 里用更新的代码补发旧版本。
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	git,
	lines,
	PUBLISHED_CRATES,
	type PublishedCrate,
	REPO,
	ROOT,
	readCargoVersion,
} from "./crates.ts";

export interface PendingRelease extends PublishedCrate {
	version: string;
	tag: string;
	// 引入这个版本号的提交，tag 打在这里
	commit: string;
}

function run(command: string, args: string[]) {
	console.log(`$ ${command} ${args.join(" ")}`);
	execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function succeeds(command: string, args: string[]): boolean {
	try {
		execFileSync(command, args, { cwd: ROOT, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function setOutput(name: string, value: string) {
	console.log(`${name}=${value}`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
	}
}

// 本次 push 在 main 上新增的提交；没有可用的 PUSH_BEFORE 时只看 HEAD
function pushedCommits(): Set<string> {
	const head = git(["rev-parse", "HEAD"]);
	const before = process.env.PUSH_BEFORE;
	if (before && !/^0+$/.test(before)) {
		try {
			return new Set(
				lines(git(["rev-list", "--first-parent", `${before}..${head}`])),
			);
		} catch {
			// before 不在历史中（例如被 force push 掉了）
		}
	}
	return new Set([head]);
}

// 沿 main 的历史往回找，版本号变成 version 的那个提交
export function introducingCommit(
	crate: PublishedCrate,
	version: string,
): string | undefined {
	const path = `${crate.dir}/Cargo.toml`;
	let introducedAt: string | undefined;
	for (const sha of lines(
		git(["log", "--first-parent", "--format=%H", "--", path]),
	)) {
		let content: string;
		try {
			content = git(["show", `${sha}:${path}`]);
		} catch {
			break;
		}
		if (readCargoVersion(content) !== version) {
			break;
		}
		introducedAt = sha;
	}
	return introducedAt;
}

export function findPending(): PendingRelease[] {
	const pushed = pushedCommits();
	const pending: PendingRelease[] = [];
	for (const crate of PUBLISHED_CRATES) {
		const content = readFileSync(
			resolve(ROOT, crate.dir, "Cargo.toml"),
			"utf-8",
		);
		const version = readCargoVersion(content);
		if (!version) {
			throw new Error(`${crate.dir}/Cargo.toml 中找不到版本号`);
		}
		const tag = `${crate.name}@${version}`;
		if (succeeds("gh", ["release", "view", tag, "--json", "tagName"])) {
			console.log(`${tag}: 已有 GitHub Release，跳过`);
			continue;
		}
		const commit = introducingCommit(crate, version);
		if (!commit || !pushed.has(commit)) {
			console.log(`${tag}: 不是本次 push 引入的版本，跳过`);
			continue;
		}
		pending.push({ ...crate, version, tag, commit });
		console.log(`${tag}: 待发布（版本号由 ${commit.slice(0, 7)} 引入）`);
	}
	return pending;
}

async function isOnCratesIo(name: string, version: string): Promise<boolean> {
	const url = `https://index.crates.io/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
	const response = await fetch(url, { cache: "no-store" });
	if (response.status === 404) {
		return false;
	}
	if (!response.ok) {
		throw new Error(`读取 ${url} 失败: ${response.status}`);
	}
	return lines(await response.text()).some(
		(line) => JSON.parse(line).vers === version,
	);
}

async function notYetUploaded(
	pending: PendingRelease[],
): Promise<PendingRelease[]> {
	const result: PendingRelease[] = [];
	for (const release of pending) {
		if (await isOnCratesIo(release.name, release.version)) {
			console.log(`${release.tag}: crates.io 上已存在，跳过上传`);
		} else {
			result.push(release);
		}
	}
	return result;
}

function packageArgs(releases: PendingRelease[]): string[] {
	return releases.flatMap((release) => ["-p", release.name]);
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) {
			return pa[i] - pb[i];
		}
	}
	return 0;
}

export function previousTag(release: PendingRelease): string | undefined {
	const versions = lines(git(["tag", "--list", `${release.name}@*`]))
		.map((tag) => tag.slice(release.name.length + 1))
		.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
		.filter((version) => compareVersions(version, release.version) < 0)
		.sort(compareVersions);
	const previous = versions.at(-1);
	return previous && `${release.name}@${previous}`;
}

// CHANGELOG 中 `## <version>` 到下一个二级标题之间的内容
export function releaseNotes(release: PendingRelease): string {
	const changelog = readFileSync(
		resolve(ROOT, release.dir, "CHANGELOG.md"),
		"utf-8",
	);
	const heading = `## ${release.version}\n`;
	const start = changelog.indexOf(heading);
	if (start < 0) {
		throw new Error(`${release.dir}/CHANGELOG.md 中找不到 ${heading.trim()}`);
	}
	const bodyStart = start + heading.length;
	const end = changelog.indexOf("\n## ", bodyStart);
	let notes = changelog.slice(bodyStart, end < 0 ? undefined : end).trim();

	const previous = previousTag(release);
	if (previous) {
		notes += `\n\n**Full Changelog**: https://github.com/${REPO}/compare/${previous}...${release.tag}`;
	}
	return notes;
}

function createTag(release: PendingRelease) {
	if (
		succeeds("git", ["rev-parse", "-q", "--verify", `refs/tags/${release.tag}`])
	) {
		console.log(`${release.tag}: tag 已存在`);
		return;
	}
	run("git", [
		"-c",
		"user.name=github-actions[bot]",
		"-c",
		"user.email=41898282+github-actions[bot]@users.noreply.github.com",
		"tag",
		"-a",
		release.tag,
		"-m",
		release.tag,
		release.commit,
	]);
	run("git", ["push", "origin", `refs/tags/${release.tag}`]);
}

function createRelease(release: PendingRelease, notesDir: string) {
	const notesFile = join(notesDir, `${release.name}.md`);
	writeFileSync(notesFile, releaseNotes(release));
	run("gh", [
		"release",
		"create",
		release.tag,
		"--title",
		release.tag,
		"--notes-file",
		notesFile,
		"--verify-tag",
		// 让 Latest 始终落在 ffmpeg_audio 上
		`--latest=${release.name === "ffmpeg_audio"}`,
	]);
}

const COMMANDS = ["plan", "package", "upload", "finalize"];

async function main(command: string | undefined) {
	if (!command || !COMMANDS.includes(command)) {
		console.error(`用法: node publish.ts <${COMMANDS.join("|")}>`);
		process.exit(1);
	}

	const pending = findPending();

	switch (command) {
		case "plan": {
			setOutput("has-pending", String(pending.length > 0));
			break;
		}
		case "package": {
			const toUpload = await notYetUploaded(pending);
			if (toUpload.length > 0) {
				run("cargo", ["package", ...packageArgs(toUpload)]);
			}
			setOutput("upload", String(toUpload.length > 0));
			break;
		}
		case "upload": {
			const toUpload = await notYetUploaded(pending);
			if (toUpload.length > 0) {
				run("cargo", ["publish", "--no-verify", ...packageArgs(toUpload)]);
			}
			break;
		}
		case "finalize": {
			const notesDir = mkdtempSync(join(tmpdir(), "release-notes-"));
			for (const release of pending) {
				createTag(release);
				createRelease(release, notesDir);
			}
			break;
		}
	}
}

if (import.meta.main) {
	await main(process.argv[2]);
}
