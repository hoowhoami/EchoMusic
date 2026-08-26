# 音效引擎与设置 UI

EchoMusic 根据引擎 manifest 生成设置，不内置酷狗音效名称或专属参数逻辑。
引擎负责算法、默认值、参数校验和实际值回显；播放器负责展示、保存和调用。
ABI 仍是 v2，以下只是 JSON 的兼容扩展。

## 预设声明

每个 `presets[]` 可以声明自己的 `controls`。显式 `controls: []` 表示无配置；
省略则兼容旧引擎的顶层 `controls`。原声不显示引擎设置。

```json
{
  "schemaVersion": 1,
  "displayName": "示例音效引擎",
  "presets": [
    {
      "id": "record",
      "label": "唱片音效",
      "supportedSampleRates": [44100, 48000, 96000],
      "controls": [
        {
          "id": "aging",
          "type": "number",
          "label": "老化程度",
          "defaultValue": 0,
          "unit": "%",
          "range": { "min": 0, "max": 100, "step": 1 },
          "ownership": "provider"
        }
      ]
    }
  ],
  "controls": []
}
```

- 设置面板支持 `number`（滑杆）、`boolean`（开关）、`select`（选项）。
- `select.options` 的 `value` 保留原 JSON 类型，数字选项不会被转换成字符串。
- 默认值优先采用 `defaultValue`，兼容旧字段 `value`。
- `description` 提供控件说明；`visibleWhen: {controlId, value}` 控制关联项显隐。
- `ownership: host/disabled`、只读类型、空选项列表不计入可配置能力。
- `supportedSampleRates` 可选；当前处理采样率不支持时禁用预设选择并给出原因。
- 预设只显示音效名称；声明可编辑参数的预设在名称右侧显示设置图标，不显示配置能力文字或实现进度。
- 点击名称选择音效，点击设置图标在原音效浮层内进入二级设置面板，不切换音效、不重复应用；不使用 Dialog。
- 面板显示目标音效、引擎名称及耳机／扬声器模式；返回箭头或 Esc 回到预设列表，保留列表滚动位置，焦点回到设置图标。
- 调节时固定浮层，不因鼠标移出而关闭；点击外部关闭整个浮层，下次打开回到列表。切换左侧栏目也会退出设置。
- 标题和恢复默认固定顶部，参数内容使用单个通用 Scrollbar。

## 应用与回显

每次发送完整的当前预设参数快照，必须保留 `presetId`：

```json
{ "presetId": "record", "controls": { "aging": { "value": 37 } } }
```

引擎先校验完整请求，再修改处理状态。无效类型、越界值、未知参数应返回失败，
不能忽略后报成功。成功后通过 `get_state_json` 返回实际生效值：

```json
{
  "schemaVersion": 1,
  "effect": { "id": "record", "name": "唱片音效" },
  "latencyFrames": 256,
  "controls": { "aging": { "value": 37, "ownership": "provider" } }
}
```

UI 同时核对预设 ID、引擎路径、设备模式、已送达 JSON 和实际参数，才显示“已应用”。
不会用上一个音效的运行时值填充新音效。正在使用的预设：滑杆拖动只预览，松手或键盘提交才应用。
其他预设（包括原声或音效文件正在使用时）：参数只自动保存，选择该预设后才生效。
进入、退出设置面板不会发送音效应用请求；引擎或输出模式改变时关闭旧设置面板。
播放设置请求串行执行，只保留最新待处理请求；过期请求的错误不能停用新选择。
诊断快照读取失败也不能被当作音效处理失败。

## 保存、切换、恢复默认

`setting.dspProviderPresetBank` 按 `[provider_id, headphone/speaker, presetId]` 保存 JSON，
通过现有 SQLite 持久化机制写入，不使用 localStorage。当前选择仍由
`dspProviderPresetJson` 表示，以兼容现有播放和重启恢复路径。

- 切换预设或输出模式时保存当前值，并读取目标组合自己的设置。
- 相同选中预设再次点击不重复应用。
- 原声取消当前音效，但不删除参数库。
- 恢复默认只重置面板中的预设、当前输出模式；非当前音效不会因此被启用。
- 升级引擎后，恢复时丢弃已删除的参数，并校验新范围、步进及选项；无效值回到默认。

## EchoMusicViper 当前接入

0.10.0 保留黑胶唱片的五个年代和 0–100% 老化程度，新增 3D旋转的速度滑杆
（0–20 整数，默认10；0为极慢速），均支持44.1/48/96kHz。速度由引擎实际处理，
UI 无需添加酷狗专属代码；旋转的低音/声场增强尚未声明为可用设置。
其他尚未实现参数处理的预设不声明控件；通用 UI 已可接收它们后续的能力声明，
这不代表它们的 macOS 算法已经完成。

重新构建并导入引擎后，点击“引擎预设 → 黑胶唱片 / 3D旋转”右侧设置图标即可调整。播放器原生模块应至少
包含运行时 `latencyFrames` 刷新支持。引擎更新不自动替换已运行进程中的动态库。

验证命令：

```sh
node --experimental-strip-types --test tests/dsp-provider-settings.test.ts tests/latest-request-queue.test.ts tests/effect-settings-navigation.test.mjs
pnpm exec vue-tsc --noEmit
ECHO_TEST_DSP_PROVIDER=/absolute/path/to/libEchoMusicViper.dylib \
  cargo test --manifest-path native/echo-ffmpeg-player/Cargo.toml \
  dsp::provider::tests::runtime_preset_ -- --ignored --nocapture
```

上述真实库测试要求0.10.0+。旋转在44.1/48/96kHz分别回报383/857/1169帧延迟，
切换回黑胶应恢复256帧；播放器不可缓存首次创建实例时的延迟。
