<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Select from '@/components/ui/Select.vue';
import Slider from '@/components/ui/Slider.vue';
import Switch from '@/components/ui/Switch.vue';
import {
  DEFAULT_WALLPAPER_FRAME_PROFILE,
  DEFAULT_WALLPAPER_SETTINGS,
  DEFAULT_WALLPAPER_TEXTURE,
  WALLPAPER_FRAME_PRESETS,
  WALLPAPER_PALETTES,
  type WallpaperPaletteKey,
  type WallpaperSettings,
  type WallpaperState,
  type WallpaperTextureSettings,
} from '../../../../shared/wallpaper';
import { sectionTitles } from '../constants';
import SettingsSectionShell from './SettingsSectionShell.vue';

// 动态壁纸：把播放页的歌词铺到桌面图标下面（Windows 专用）
const isWindows = computed(() => window.electron?.platform === 'win32');
const enabled = ref(false);
const busy = ref(false);
const message = ref('');
const settings = ref<WallpaperSettings>({
  ...DEFAULT_WALLPAPER_SETTINGS,
  texture: { ...DEFAULT_WALLPAPER_TEXTURE },
});
const displays = ref<WallpaperState['displays']>([]);

const contentModeOptions = [
  { label: '跟随播放页', value: 'follow' },
  { label: '仅歌词', value: 'lyric' },
];
const pauseOptions = [
  { label: '暂停壁纸', value: 'freeze' },
  { label: '关闭壁纸', value: 'hide' },
];
// 绘制性能档位：一档同时决定正常播放与被遮挡两档帧率，滑动条取值即档位下标
const frameProfileIndex = computed(() => {
  const index = WALLPAPER_FRAME_PRESETS.findIndex(
    (item) => item.key === settings.value.frameProfile,
  );
  if (index >= 0) return index;
  const fallback = WALLPAPER_FRAME_PRESETS.findIndex(
    (item) => item.key === DEFAULT_WALLPAPER_FRAME_PROFILE,
  );
  return fallback >= 0 ? fallback : 0;
});
const currentFramePreset = computed(
  () => WALLPAPER_FRAME_PRESETS[frameProfileIndex.value] ?? WALLPAPER_FRAME_PRESETS[0],
);
const frameProfileHint = computed(
  () =>
    '播放 ' +
    currentFramePreset.value.playing +
    ' 帧，桌面被挡住 ' +
    currentFramePreset.value.occluded +
    ' 帧',
);
const formatFrameProfile = (value: number) => WALLPAPER_FRAME_PRESETS[value]?.label ?? '';
const setFrameProfile = (value: number) => {
  const preset = WALLPAPER_FRAME_PRESETS[value];
  if (!preset) return;
  void setSettings({ frameProfile: preset.key });
};
// 「仅歌词」画面质感的可调参数：密度、浓度、压黑范围与粒子数量/大小
type TextureNumericKey = 'edgeStart' | 'edgeDarkness' | 'particleDensity' | 'particleSize';

type TextureKnob = {
  key: TextureNumericKey;
  group: 'dim' | 'particle';
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  unit: 'px' | 'percent';
};

const textureKnobs: TextureKnob[] = [
  {
    key: 'edgeStart',
    group: 'dim',
    label: '压黑范围',
    hint: '从屏幕中心往外多少开始压黑，越小压黑越靠内',
    min: 0,
    max: 100,
    step: 1,
    unit: 'percent',
  },
  {
    key: 'edgeDarkness',
    group: 'dim',
    label: '压黑暗度',
    hint: '贴近屏幕边缘时最深能压到多黑',
    min: 0,
    max: 100,
    step: 1,
    unit: 'percent',
  },
  {
    key: 'particleDensity',
    group: 'particle',
    label: '浮尘数量',
    hint: '画面里飘着的尘埃颗粒，100% 为默认',
    min: 0,
    max: 200,
    step: 5,
    unit: 'percent',
  },
  {
    key: 'particleSize',
    group: 'particle',
    label: '浮尘大小',
    hint: '尘埃颗粒的尺寸，100% 为默认',
    min: 0,
    max: 200,
    step: 5,
    unit: 'percent',
  },
];

// 界面上按百分比/像素显示，存进设置里的仍是原始单位
const KNOB_SCALE: Record<string, number> = {
  edgeStart: 100,
  edgeDarkness: 100,
  particleDensity: 100,
  particleSize: 100,
};

const dimKnobs = textureKnobs.filter((item) => item.group === 'dim');
const particleKnobs = textureKnobs.filter((item) => item.group === 'particle');

// 五套配色：压暗底色、浮尘颜色、歌词颜色成套切换，只在桌面壁纸上生效
const paletteOptions = WALLPAPER_PALETTES.map((item) => ({ label: item.label, value: item.key }));

const currentTexture = computed<WallpaperTextureSettings>(
  () => settings.value.texture ?? DEFAULT_WALLPAPER_TEXTURE,
);

const knobValue = (knob: TextureKnob) =>
  Math.round(currentTexture.value[knob.key] * KNOB_SCALE[knob.key]);

const setTextureKnob = (knob: TextureKnob, value: number) => {
  const scale = KNOB_SCALE[knob.key];
  void setSettings({ texture: { ...currentTexture.value, [knob.key]: value / scale } });
};

const formatKnob = (knob: TextureKnob, value: number) =>
  knob.unit === 'percent' ? value + '%' : value.toFixed(1) + 'px';

// 压暗、壁纸穿透与浮尘各自一个开关，关掉时它下面的参数也一起收起来
const setTextureFlag = (
  key: 'dimEnabled' | 'particleEnabled' | 'passthroughEnabled',
  value: boolean,
) => {
  void setSettings({ texture: { ...currentTexture.value, [key]: value } });
};

const setPalette = (key: WallpaperPaletteKey) => {
  void setSettings({ palette: key });
};

const nearSlider = (a: number, b: number) => Math.abs(a - b) < 1e-6;

// 只有「已经打开的那一组」参数偏离默认时才让按钮可点；没开的项不归它管。
// 配色是独立设置，不参与这里。
// 壁纸穿透没有自己的滑杆，只要它偏离默认（开着）就让按钮可点，否则压暗关掉时没入口复位它。
const canResetTexture = computed(() => {
  const current = currentTexture.value;
  const defaults = DEFAULT_WALLPAPER_TEXTURE;
  if (current.passthroughEnabled !== defaults.passthroughEnabled) return true;
  if (
    current.dimEnabled &&
    (!nearSlider(current.edgeStart, defaults.edgeStart) ||
      !nearSlider(current.edgeDarkness, defaults.edgeDarkness))
  ) {
    return true;
  }
  return (
    current.particleEnabled &&
    (!nearSlider(current.particleDensity, defaults.particleDensity) ||
      !nearSlider(current.particleSize, defaults.particleSize))
  );
});

// 只把已打开的那一组拉回默认值，不会顺手把没开的开关打开；
// 壁纸穿透不跟压暗走，一并复位成默认（关闭）
const resetTexture = () => {
  const current = currentTexture.value;
  const defaults = DEFAULT_WALLPAPER_TEXTURE;
  const next: WallpaperTextureSettings = { ...current };
  if (current.dimEnabled) {
    next.edgeStart = defaults.edgeStart;
    next.edgeDarkness = defaults.edgeDarkness;
  }
  if (current.particleEnabled) {
    next.particleDensity = defaults.particleDensity;
    next.particleSize = defaults.particleSize;
  }
  next.passthroughEnabled = defaults.passthroughEnabled;
  void setSettings({ texture: next });
};

let alive = true;
let receivedState = false;
let disposeState: (() => void) | undefined;

const displayIds = computed(() => settings.value.displayIds);
// 只有一块屏幕时按屏开关没有任何含义，整块不渲染（不是置灰）。
const multiDisplay = computed(() => displays.value.length > 1);
// 每一项换行都要解释清楚，否则用户只能靠猜。
const contentModeHint = computed(() => {
  switch (settings.value.contentMode) {
    case 'lyric':
      return '保留当前皮肤的歌词样式，去掉背景和封面，露出系统桌面壁纸';
    default:
      return '与播放页完全一致，含皮肤与视图模式';
  }
});
// 提示语只讲当前选中的那一档，两档混在一起看反而要猜。
const pauseHint = computed(() =>
  settings.value.pauseBehavior === 'hide'
    ? '暂停播放后收起壁纸，露出系统桌面壁纸'
    : '暂停播放后画面暂停，壁纸不会消失',
);

const applyState = (state: WallpaperState) => {
  if (!alive) return;
  enabled.value = Boolean(state.enabled);
  if (state.settings) settings.value = state.settings;
  displays.value = Array.isArray(state.displays) ? state.displays : [];
  message.value = describeState(state);
};
const describeState = (state: WallpaperState) => {
  if (!state.supported) return '当前系统暂不支持动态歌词壁纸';
  if (!state.enabled) return '把正在播放的歌词铺在桌面图标下面';
  if (state.reason === 'fullscreen') return '全屏应用正在运行，退出后自动恢复';
  if (state.reason === 'covered') return '窗口占满桌面，壁纸暂停刷新';
  if (state.reason === 'occluded') return `歌词被窗口挡住，已降到 ${state.frameRate} 帧`;
  if (state.reason === 'paused') return '已暂停播放，壁纸停止刷新';
  if (!state.attached) return '桌面层还没准备好，稍后会自动重试';
  return '正在桌面层显示';
};
const onState = (raw: unknown) => {
  if (!raw || typeof raw !== 'object') return;
  receivedState = true;
  applyState(raw as WallpaperState);
};
onMounted(async () => {
  if (!isWindows.value) return;
  try {
    disposeState = window.electron.wallpaper.onStateChange(onState);
    const state = await window.electron.wallpaper.getState();
    if (!receivedState) applyState(state);
  } catch {
    message.value = '读取失败，可稍后重试';
  }
});
onUnmounted(() => {
  alive = false;
  disposeState?.();
});
const setEnabled = async (value: boolean) => {
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    applyState(await window.electron.wallpaper.setEnabled(value));
  } catch (error) {
    message.value = `打开失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    busy.value = false;
  }
};
const setSettings = async (patch: Partial<WallpaperSettings>) => {
  // 本地先合上：开关和滑块立刻跟手，主进程返回的权威状态再对齐一次。
  settings.value = { ...settings.value, ...patch };
  try {
    applyState(await window.electron.wallpaper.setSettings(patch));
  } catch (error) {
    if (alive)
      message.value = `设置失败：${error instanceof Error ? error.message : String(error)}`;
    // 乐观更新失败时把界面拉回主进程的真实状态，别停在假值上。
    if (alive) {
      try {
        applyState(await window.electron.wallpaper.getState());
      } catch {
        /* 读取也失败就保持原样，下一次状态广播会纠正 */
      }
    }
  }
};
const toggleDisplay = (id: string, value: boolean) => {
  const current = settings.value.displayIds ?? [];
  const next = value ? [...current, id] : current.filter((item) => item !== id);
  // 至少保留一个显示器，否则壁纸无处可画
  if (next.length === 0) return;
  void setSettings({ displayIds: next });
};
const displayLabel = (display: WallpaperState['displays'][number]) =>
  `${display.width} × ${display.height}${display.primary ? ' · 主屏' : ''}`;
</script>

<template>
  <SettingsSectionShell v-if="isWindows" id="wallpaper" :title="sectionTitles.wallpaper.label">
    <template #icon>
      <Icon :icon="sectionTitles.wallpaper.icon" width="20" height="20" class="text-primary-text" />
    </template>
    <div class="settings-item">
      <div class="min-w-0 flex-1 space-y-1">
        <h3 class="font-semibold">启用动态歌词壁纸</h3>
        <p
          id="wallpaper-status"
          role="status"
          aria-live="polite"
          class="text-sm text-text-secondary"
        >
          {{ message || '把正在播放的歌词铺在桌面图标下面' }}
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <Switch
          aria-label="启用动态歌词壁纸"
          aria-describedby="wallpaper-status"
          :model-value="enabled"
          :disabled="busy"
          @update:model-value="setEnabled(Boolean($event))"
        />
      </div>
    </div>
    <!-- 关闭壁纸时下面的细项没有意义，收起来保持界面干净 -->
    <template v-if="enabled">
      <template v-if="multiDisplay">
        <div v-for="display in displays" :key="display.id" class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">{{ display.label }}</h3>
            <p class="text-sm text-text-secondary">{{ displayLabel(display) }}</p>
          </div>
          <Switch
            :aria-label="`在${display.label}显示壁纸`"
            :model-value="displayIds.includes(display.id)"
            :disabled="displayIds.length === 1 && displayIds.includes(display.id)"
            @update:model-value="toggleDisplay(display.id, Boolean($event))"
          />
        </div>
      </template>
      <!-- 配色是整体外观，只在仅歌词下有意义，不参与「画面质感」的恢复默认 -->
      <template v-if="settings.contentMode === 'lyric'">
        <div class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">配色</h3>
            <p class="text-sm text-text-secondary">
              压暗、浮尘与歌词的整套颜色，仅在歌词壁纸上生效
            </p>
          </div>
          <Select
            class="shrink-0 w-45"
            aria-label="壁纸配色"
            :model-value="settings.palette"
            :options="paletteOptions"
            @update:model-value="setPalette($event as WallpaperPaletteKey)"
          />
        </div>
      </template>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">显示内容</h3>
          <p class="text-sm text-text-secondary">{{ contentModeHint }}</p>
        </div>
        <Select
          class="shrink-0 w-45"
          aria-label="壁纸显示内容"
          :model-value="settings.contentMode"
          :options="contentModeOptions"
          @update:model-value="
            setSettings({ contentMode: $event as WallpaperSettings['contentMode'] })
          "
        />
      </div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">暂停时</h3>
          <p class="text-sm text-text-secondary">{{ pauseHint }}</p>
        </div>
        <Select
          class="shrink-0 w-45"
          aria-label="暂停时的壁纸行为"
          :model-value="settings.pauseBehavior"
          :options="pauseOptions"
          @update:model-value="
            setSettings({ pauseBehavior: $event as WallpaperSettings['pauseBehavior'] })
          "
        />
      </div>
      <div class="settings-item">
        <div class="min-w-0 flex-1 space-y-1">
          <h3 class="font-semibold">绘制性能</h3>
          <p class="text-sm text-text-secondary">{{ frameProfileHint }}</p>
        </div>
        <Slider
          class="shrink-0 w-45"
          aria-label="绘制性能档位"
          :model-value="frameProfileIndex"
          :min="0"
          :max="WALLPAPER_FRAME_PRESETS.length - 1"
          :step="1"
          :format-value="formatFrameProfile"
          @update:model-value="setFrameProfile"
        />
      </div>
      <!-- 仅歌词模式才有压暗与浮尘，其他模式不展示这些参数 -->
      <template v-if="settings.contentMode === 'lyric'">
        <div class="settings-divider"></div>
        <div class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">画面质感</h3>
            <p class="text-sm text-text-secondary">仅在仅歌词模式下生效</p>
          </div>
          <Button
            variant="unstyled"
            size="default"
            class="settings-action"
            :disabled="!canResetTexture"
            @click="resetTexture"
          >
            恢复默认
          </Button>
        </div>
        <div class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">压暗</h3>
            <p class="text-sm text-text-secondary">画面中间浅、四周黑，越靠屏幕边缘越暗</p>
          </div>
          <Switch
            aria-label="压暗"
            :model-value="currentTexture.dimEnabled"
            @update:model-value="setTextureFlag('dimEnabled', Boolean($event))"
          />
        </div>
        <template v-if="currentTexture.dimEnabled">
          <div v-for="knob in dimKnobs" :key="knob.key" class="settings-item">
            <div class="min-w-0 flex-1 space-y-1">
              <h3 class="font-semibold">{{ knob.label }}</h3>
              <p class="text-sm text-text-secondary">{{ knob.hint }}</p>
            </div>
            <Slider
              class="shrink-0 w-45"
              :aria-label="knob.label"
              :min="knob.min"
              :max="knob.max"
              :step="knob.step"
              show-value
              :format-value="(value: number) => formatKnob(knob, value)"
              :model-value="knobValue(knob)"
              @update:model-value="setTextureKnob(knob, Number($event))"
            />
          </div>
        </template>
        <!-- 壁纸穿透只在压暗打开时才有意义：没压暗就不存在"要不要透出壁纸"的选择 -->
        <div v-if="currentTexture.dimEnabled" class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">壁纸穿透</h3>
            <p class="text-sm text-text-secondary">开启时露出桌面壁纸，关闭只显示当前配色的底色</p>
          </div>
          <Switch
            aria-label="壁纸穿透"
            :model-value="currentTexture.passthroughEnabled"
            @update:model-value="setTextureFlag('passthroughEnabled', Boolean($event))"
          />
        </div>
        <div class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">浮尘粒子</h3>
            <p class="text-sm text-text-secondary">画面里缓慢上浮的尘埃，增加层次感</p>
          </div>
          <Switch
            aria-label="浮尘粒子"
            :model-value="currentTexture.particleEnabled"
            @update:model-value="setTextureFlag('particleEnabled', Boolean($event))"
          />
        </div>
        <template v-if="currentTexture.particleEnabled">
          <div v-for="knob in particleKnobs" :key="knob.key" class="settings-item">
            <div class="min-w-0 flex-1 space-y-1">
              <h3 class="font-semibold">{{ knob.label }}</h3>
              <p class="text-sm text-text-secondary">{{ knob.hint }}</p>
            </div>
            <Slider
              class="shrink-0 w-45"
              :aria-label="knob.label"
              :min="knob.min"
              :max="knob.max"
              :step="knob.step"
              show-value
              :format-value="(value: number) => formatKnob(knob, value)"
              :model-value="knobValue(knob)"
              @update:model-value="setTextureKnob(knob, Number($event))"
            />
          </div>
        </template>
      </template>
    </template>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
