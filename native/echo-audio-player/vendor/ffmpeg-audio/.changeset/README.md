# 变更碎片

这里存放尚未发布的变更记录（changesets）。每个影响使用者的改动都要附带一个碎片；发版时它们会被汇总进各 crate 的 `CHANGELOG.md`，并决定版本号怎么升。流程见 [ADR 0002](../docs/adr/0002-changelog-from-changesets.md)。

## 新建碎片

```sh
pnpm changeset
```

按提示选择 crate 和版本级别，再写正文。也可以直接手写一个 `.changeset/<任意名字>.md`：

```md
---
"ffmpeg_audio": patch
---

**Fixed** accurate seeking trimming one sample too many when ...
```

## 写法约定

- **一个碎片只写一条记录**，写成一段话，不要写成列表。有多条改动就写多个碎片。
- 正文用英文，开头用粗体动词表示分类：**Added**、**Changed**、**Fixed**、**Removed**、**Refactored**、**Documented**、**Updated** 等。
- 版本级别：
  - 0.x 阶段，破坏性变更写 `minor`，其他都写 `patch`。**不要写 `major`**，它会直接升到 1.0.0，CI 会拦下来。
  - 1.0 之后，破坏性变更写 `major`，新增功能写 `minor`，其他写 `patch`。
- `ffmpeg_audio` 公开导出了 `ffmpeg_audio_sys`（`pub use ffmpeg_audio_sys as sys`）。所以 **sys 有破坏性变更时，要在同一个碎片里给 `ffmpeg_audio` 写上同级别的版本**，CI 会检查。sys 的其他改动不需要，`ffmpeg_audio` 会自动跟着升 patch。
- changelog 里的 PR 链接、提交链接和致谢是自动生成的。需要改成别的 PR 或提交时，在正文前加一行 `pr: 123` 或 `commit: <sha>`。
