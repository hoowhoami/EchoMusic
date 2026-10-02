// 检查待发布的碎片是否符合约定：
// 1. 1.0 之前不能用 major：semver 会把 0.x 直接升到 1.0.0。0.x 阶段的破坏性变更请用 minor。
//    真要发布 1.0 时，临时设置环境变量 ALLOW_1_0=true 放行。
// 2. ffmpeg_audio 通过 `pub use ffmpeg_audio_sys as sys` 公开导出了 sys，
//    所以 sys 有破坏性变更时，ffmpeg_audio 也必须按破坏性变更升版本。
import { getReleasePlan } from "@changesets/get-release-plan";
import { ROOT } from "./crates.ts";

type Release = Awaited<ReturnType<typeof getReleasePlan>>["releases"][number];

function breakingTypes(release: Release): string[] {
	return release.oldVersion?.startsWith("0.") ? ["minor", "major"] : ["major"];
}

function isBreaking(release: Release | undefined): boolean {
	return !!release && breakingTypes(release).includes(release.type);
}

const plan = await getReleasePlan(ROOT);
const errors: string[] = [];

// 给 name 写了 types 中某个级别的碎片
function changesetsBumping(name: string, types: string[]): string {
	return plan.changesets
		.filter((cs) =>
			cs.releases.some((r) => r.name === name && types.includes(r.type)),
		)
		.map((cs) => `.changeset/${cs.id}.md`)
		.join(", ");
}

for (const release of plan.releases) {
	if (
		release.type === "major" &&
		release.oldVersion.startsWith("0.") &&
		process.env.ALLOW_1_0 !== "true"
	) {
		errors.push(
			`${release.name} 会从 ${release.oldVersion} 升到 ${release.newVersion}。` +
				`0.x 阶段的破坏性变更请写 minor，而不是 major（${changesetsBumping(release.name, ["major"])}）`,
		);
	}
}

const sys = plan.releases.find((r) => r.name === "ffmpeg_audio_sys");
const audio = plan.releases.find((r) => r.name === "ffmpeg_audio");
if (sys && isBreaking(sys) && !isBreaking(audio)) {
	errors.push(
		`ffmpeg_audio_sys 有破坏性变更（${sys.oldVersion} → ${sys.newVersion}），` +
			"而 ffmpeg_audio 公开导出了它，也必须按破坏性变更升版本。" +
			`请在同一个碎片里给 ffmpeg_audio 也写上同级别的版本（${changesetsBumping(sys.name, breakingTypes(sys))}）`,
	);
}

if (errors.length > 0) {
	for (const error of errors) {
		console.error(`错误: ${error}`);
	}
	process.exit(1);
}

for (const release of plan.releases) {
	console.log(
		`${release.name}: ${release.oldVersion} → ${release.newVersion} (${release.type})`,
	);
}
console.log("碎片检查通过");
