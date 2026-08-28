# 音效引擎与设置 UI

EchoMusic 根据引擎 manifest 生成设置，不内置任何 Provider 的音效名称或专属参数逻辑。
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
      "recommendedDevice": "headphone",
      "supportedSampleRates": [44100, 48000, 96000],
      "controls": [
        {
          "id": "aging",
          "type": "number",
          "label": "老化程度",
          "defaultValue": 0,
          "unit": "%",
          "range": {
            "min": 0,
            "max": 100,
            "step": 1,
            "minLabel": "全新",
            "maxLabel": "老化",
            "inverted": true
          },
          "ownership": "provider"
        }
      ]
    }
  ],
  "controls": []
}
```

- 设置面板支持 `number`（滑杆）、`boolean`（项目统一 `Switch`）、`select`（项目统一
  `Select`）。布尔控件可用值为 `true` / `false` 的 `options` 自定义 Switch 两侧文案，
  也可用 `disabled: true` 禁止切换到当前不可用的一侧。
- `select.options` 的 `value` 保留原 JSON 类型，数字选项不会被转换成字符串。
- `select.options[].disabled: true` 表示能力已声明但当前不可选；播放器使用项目统一
  `Select` 组件展示禁用态，且不会保存或下发该值。
- 默认值优先采用 `defaultValue`，兼容旧字段 `value`。
- `description` 提供控件说明；`visibleWhen: {controlId, value}` 控制关联项显隐。
- 数值控件可通过 `range.minLabel/maxLabel` 描述两端、`range.inverted` 反转视觉方向；
  标签随方向交换，保存和下发的数值不变。老引擎未声明这些字段时保持原有呈现，
  不根据预设名字猜测方向。
- 选项复用项目 `Select`，选项值经可逆编码保留原JSON类型；嵌套菜单不关闭外层音效面板。
- `ownership: host/disabled`、只读类型、空选项列表不计入可配置能力。
- `supportedSampleRates` 可选；当前处理采样率不支持时禁用预设选择并给出原因。
- `recommendedDevice: "headphone"` 可选；播放器在预设名称旁显示“耳机”标签。这只是
  试听设备建议，不限制 Provider 的耳机／扬声器模式，也不影响预设是否可选。未知值忽略。
- 预设显示音效名称和可选设备建议；声明可编辑参数的预设在名称右侧显示设置图标，不显示配置能力文字或实现进度。
- 点击名称选择音效，点击设置图标在原音效浮层内进入二级设置面板，不切换音效、不重复应用；不使用 Dialog。
- 面板显示目标音效、引擎名称及耳机／扬声器模式；返回箭头或 Esc 回到预设列表，保留列表滚动位置，焦点回到设置图标。
- Provider 启用期间由引擎完整接管 DSP 图，宿主均衡器不可调节；用户已有 EQ 设置只保留、不叠加，切回内置音效引擎后恢复。
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

### 已下载／导入音效的能力检查

「我的音效」、广场内已下载项及下载提示里的「立即使用」共用播放器的资源能力检查，
不因文件已经下载就允许应用。当前引擎必须声明对应 `resources.kind`，若声明
`extensions` 还须包含文件扩展名；组合音效必须同时支持 VPF 和卷积资源，不能只播放其中一部分。
未声明资源能力或声明不匹配时禁选，鼠标悬停显示原因。无第三方引擎时，内置引擎仍可
处理纯卷积音效，但不支持 VPF／组合音效。

下载页的按钮和使用操作共用结构化能力状态：只有 `supported` 可以操作，
`checking` 显示「检查中」并禁用，`unsupported` 显示「不可用」及原因。
已下载项还须满足当前在线条目的可用性与完整资源要求，不能用旧的单卷积记录
启用需要 VPF + 卷积的组合音效；缺少资源时提示移除后重新下载，文件不会自动删除。
有效的本地文件不因在线下载链接缺失而不可用。下载提示的「立即使用」在点击时
重新校验当前引擎、条目和下载记录，切换引擎或移除文件后不能借旧提示绕过限制。

检查由播放器 Store 管理，关闭音效弹窗也有效：

- 启动或切换引擎时先等待能力确认；检查期间禁选，不提交资源，但不提前删除保存的选择。
- 优先使用与设置中的引擎路径、模式匹配的运行图清单，否则通过现有引擎检查接口读取。
  旧引擎快照、过期异步检查结果不能覆盖新选择。
- 确认已选文件不支持后，自动切换到「原声」并提示；只取消启用，保留文件和记录，
  不停用仍可工作的引擎，也不改动均衡器或歌曲音效。
- 恢复支持后不会自动重新启用，需要用户手动选择。重启仍保持原声状态，沿用现有
  SQLite 设置持久化，不新增 localStorage 或持久化能力缓存。
- 资源实际应用失败时也先卸载该音效回原声；只有引擎本身无法加载时才走引擎停用逻辑。

定向回归：

```sh
node --experimental-strip-types --test tests/audio-effect-support.test.mjs tests/effect-settings-navigation.test.mjs tests/dsp-provider-settings.test.ts tests/latest-request-queue.test.ts
```

### 引擎预设参数保存

`setting.dspProviderPresetBank` 按 `[provider_id, headphone/speaker, presetId]` 保存 JSON，
通过现有 SQLite 持久化机制写入，不使用 localStorage。当前选择仍由
`dspProviderPresetJson` 表示，以兼容现有播放和重启恢复路径。

- 切换预设或输出模式时保存当前值，并读取目标组合自己的设置。
- 相同选中预设再次点击不重复应用。
- 原声取消当前音效，但不删除参数库。
- 恢复默认只重置面板中的预设、当前输出模式；非当前音效不会因此被启用。
- 升级引擎后，恢复时丢弃已删除的参数，并校验新范围、步进及选项；无效值回到默认。

## 验证

EchoMusic 的测试只验证通用 manifest、设置持久化、资源能力和 ABI 宿主行为。
具体 Provider 的预设、参数映射、算法输出、采样率及延迟应在对应 Provider 仓库验证。

```sh
node --experimental-strip-types --test tests/audio-effect-support.test.mjs tests/dsp-provider-settings.test.ts tests/latest-request-queue.test.ts tests/effect-settings-navigation.test.mjs
pnpm exec vue-tsc --noEmit
cargo test --manifest-path native/echo-ffmpeg-player/Cargo.toml
```
