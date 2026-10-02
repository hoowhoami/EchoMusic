# 用 changesets 碎片维护 changelog，每个 crate 各自打 tag

发版要做的事情越来越多：切版、改 `Cargo.toml` 版本号、打 tag、按顺序发布两个 crate、建 GitHub Release，其中建 Release 已经漏过（v0.1.2 没有 Release）。我们决定改由 CI 发版：每个影响使用者的改动附带一个 changesets 碎片（`.changeset/*.md`），push 到 main 后自动生成 release PR，合并它即发版。changesets 只认识 npm 包，所以在两个发布的 crate 目录下各放一个 private 的 `package.json` 承载版本号，再由脚本同步到 `Cargo.toml`。

changelog 不从提交信息生成：提交信息是中文的，而且 `refactor` 里常混有使用者能感知的改动，生成出来的内容比手写的英文 changelog 差很多。碎片让每条记录仍然由人来写，同时不会在 `[Unreleased]` 上冲突，PR 里也能检查有没有写。

## Considered Options

- **继续手写 `[Unreleased]`，只自动化切版**：能保留原有的 changelog 格式，但无法在 PR 里检查是否写了记录；被否决。
- **从 Conventional Commits 生成（git-cliff、release-plz）**：原因见上；被否决。
- **knope**：同样基于碎片，但多包模式下强制给每个包打 `名字/v版本` 的 tag，两个包共用一个 CHANGELOG 时会互相覆盖，只改 sys 时也不会连带升 `ffmpeg_audio`；被否决。
- **changie 或自己写脚本汇总碎片**：能保留原来「一个 CHANGELOG、按 crate 分节」的格式，但版本计算、release PR、GitHub Release 都要自己实现；changesets 自带这些，格式上的代价可以接受。

## Consequences

- 每个 crate 各有一份 `CHANGELOG.md`，采用 changesets 的格式（`## 0.4.0` 下分 Major/Minor/Patch Changes，每条带提交或 PR 链接和致谢）。分类靠每条开头的粗体动词表达。0.4.0 之前的历史按 crate 拆分后原样保留在这两个文件中，根目录的 `CHANGELOG.md` 只剩索引。
- tag 从 `v0.3.1` 改为每个 crate 各自打 `ffmpeg_audio@0.4.0`、`ffmpeg_audio_sys@0.2.0`，GitHub Release 也是每个 crate 一个，Latest 总是 `ffmpeg_audio`。旧的 `v*` tag 保留。
- 0.x 阶段破坏性变更要写 `minor` 而不是 `major`，否则会直接升到 1.0.0；CI 会拦下 1.0 之前的 `major`。
- `ffmpeg_audio` 通过 `pub use ffmpeg_audio_sys as sys` 公开导出 sys，因此：sys 发布新版本时 `ffmpeg_audio` 至少升 patch（changesets 自动处理），并把依赖声明改为 sys 的新版本；sys 有破坏性变更时 `ffmpeg_audio` 也必须按破坏性变更升版本，由 CI 检查。
- 发布前会对合并后的提交完整跑一遍 CI，然后通过 crates.io Trusted Publishing 上传，仓库里不保存发布 token。
