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

- 设置面板支持 `number`（滑杆）、`boolean`（开关）、`select`（选项）。
- `select.options` 的 `value` 保留原 JSON 类型，数字选项不会被转换成字符串。
- 默认值优先采用 `defaultValue`，兼容旧字段 `value`。
- `description` 提供控件说明；`visibleWhen: {controlId, value}` 控制关联项显隐。
- 数值控件可通过 `range.minLabel/maxLabel` 描述两端、`range.inverted` 反转视觉方向；
  标签随方向交换，保存和下发的数值不变。黑胶为左侧老化100%、右侧全新0%。
  老引擎未声明这些字段时保持原有呈现，不根据预设名字猜测方向。
- 选项复用项目 `Select`，选项值经可逆编码保留原JSON类型；嵌套菜单不关闭外层音效面板。
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

### 已下载／导入音效的能力检查

「我的音效」、广场内已下载项及下载提示里的「立即使用」共用播放器的资源能力检查，
不因文件已经下载就允许应用。当前引擎必须声明对应 `resources.kind`，若声明
`extensions` 还须包含文件扩展名；组合音效必须同时支持 VPF 和卷积资源，不能只播放其中一部分。
未声明资源能力或声明不匹配时禁选，鼠标悬停显示原因。无第三方引擎时，内置引擎仍可
处理纯卷积音效，但不支持 VPF／组合音效。

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

## EchoMusicViper 当前接入

0.12.0 支持黑胶唱片的五个年代和 0–100% 老化程度、3D旋转的三条滑杆
（旋转速度0–20／默认10、超重低音0–400／默认0、声场大小0–4／默认0，均为整数；速度0为极慢速），以及声乐古风的人声／乐器平衡
（0–100% 整数，默认25%；左侧人声、右侧乐器），均支持44.1/48/96kHz。
这些参数由引擎实际处理，UI 无需添加酷狗专属代码；旋转低音/声场均为0时完全绕过新增增强链。
新引擎通过每预设 `controls` 声明三项设置，现有弹出层内设置面板按声明顺序自动展示。
旧参数库只有速度时，保留原速度并补齐低音0／声场0；不清空SQLite、不迁移到localStorage。
点击重置恢复10／0／0，切换音效和重启仍通过原参数库恢复。
保留0.11.1黑胶老化滑杆的端点文字和方向描述；已有DSP数值及保存含义不变。
其他尚未实现参数处理的预设不声明控件；通用 UI 已可接收它们后续的能力声明，
这不代表它们的 macOS 算法已经完成。

重新构建并导入引擎后，点击“引擎预设 → 黑胶唱片 / 3D旋转 / 声乐古风”右侧设置图标即可调整。播放器原生模块应至少
包含运行时 `latencyFrames` 刷新支持。引擎更新不自动替换已运行进程中的动态库。

验证命令：

```sh
node --experimental-strip-types --test tests/dsp-provider-settings.test.ts tests/latest-request-queue.test.ts tests/effect-settings-navigation.test.mjs
pnpm exec vue-tsc --noEmit
ECHO_TEST_DSP_PROVIDER=/absolute/path/to/libEchoMusicViper.dylib \
  cargo test --manifest-path native/echo-ffmpeg-player/Cargo.toml \
  dsp::provider::tests::runtime_preset_ -- --ignored --nocapture
```

上述四项真实库测试要求0.12.0+。旋转默认在44.1/48/96kHz分别回报383/857/1169帧延迟，
开启低音或声场后分别为4734/5208/10223帧；两项均归零即恢复默认延迟。
声乐古风为8447帧；切换回黑胶应恢复256帧。播放器不可缓存首次创建实例时的延迟。
