// 选出本次 CI 要跑的 target，把矩阵的 include 数组写进 GITHUB_OUTPUT，供 ci.yml 的
// test job 用 `fromJSON()` 读取。
//
// 何时跑完整矩阵由 ci.yml 判定后通过 FULL 传进来：PR 与发版前为 true，
// `main` 上的普通提交为 false（此时只跑 platforms.ts 里的常驻子集）。
//
// 本地可以直接跑：FULL=true node scripts/ci/select-platforms.ts
import { appendFileSync } from "node:fs";
import { ALL_PLATFORMS, PUSH_PLATFORMS } from "./platforms.ts";

const full = String(process.env.FULL ?? "").toLowerCase() === "true";

const unknown = PUSH_PLATFORMS.filter(
	(target) => !ALL_PLATFORMS.some((platform) => platform.target === target),
);
if (unknown.length > 0) {
	throw new Error(
		`PUSH_PLATFORMS 里的 target 不在 ALL_PLATFORMS 中：${unknown.join(", ")}`,
	);
}

const selected = full
	? ALL_PLATFORMS
	: ALL_PLATFORMS.filter((platform) =>
			PUSH_PLATFORMS.includes(platform.target),
		);

const include = JSON.stringify(selected);
const output = process.env.GITHUB_OUTPUT;
if (output) {
	// JSON.stringify 不会产生换行，单行写法即可；没有值时才需要 heredoc 形式
	appendFileSync(output, `include=${include}\n`);
}

console.log(
	`${full ? "完整矩阵" : "常驻子集"}，共 ${selected.length} 个 target：`,
);
for (const platform of selected) {
	console.log(`  - ${platform.target} (${platform.os})`);
}
