// PR 检查：改动了已发布 crate 的源码时，PR 里必须新增（或修改）一个碎片。
// 打了 no-changelog 标签的 PR 不会运行这个检查，见 .github/workflows/changeset-check.yml。
// 用法: node scripts/release/check-changeset-added.ts <base-sha> <head-sha>
import { git, lines, PUBLISHED_CRATES } from "./crates.ts";

// tests、examples 和文档不影响发布出去的 crate 的行为
const NON_SOURCE_PATTERN = /^(tests|examples|benches)\/|\.md$|^package\.json$/;

function isCrateSource(path: string): boolean {
	return PUBLISHED_CRATES.some((crate) => {
		const prefix = `${crate.dir}/`;
		return (
			path.startsWith(prefix) &&
			!NON_SOURCE_PATTERN.test(path.slice(prefix.length))
		);
	});
}

const [base, head] = process.argv.slice(2);
if (!base || !head) {
	console.error("用法: node check-changeset-added.ts <base-sha> <head-sha>");
	process.exit(1);
}

const range = `${base}...${head}`;
const sources = lines(git(["diff", "--name-only", range])).filter(
	isCrateSource,
);
if (sources.length === 0) {
	console.log("没有改动已发布 crate 的源码，不需要碎片");
	process.exit(0);
}

const fragments = lines(
	git(["diff", "--name-only", "--diff-filter=AM", range, "--", ".changeset"]),
)
	.filter((path) => /^\.changeset\/[^/]+\.md$/.test(path))
	.filter((path) => path !== ".changeset/README.md");
if (fragments.length > 0) {
	console.log(`找到碎片: ${fragments.join(", ")}`);
	process.exit(0);
}

console.error("这个 PR 改动了已发布 crate 的源码，但没有新增碎片：");
for (const path of sources) {
	console.error(`  ${path}`);
}
console.error(
	"请运行 pnpm changeset 新增一个碎片，写法见 .changeset/README.md。" +
		"如果改动不影响使用者，可以请维护者加上 no-changelog 标签。",
);
process.exit(1);
