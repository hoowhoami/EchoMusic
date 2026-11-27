<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Button from '@/components/ui/Button.vue';
import Select from '@/components/ui/Select.vue';
import Slider from '@/components/ui/Slider.vue';
import Switch from '@/components/ui/Switch.vue';
import {
  DEFAULT_WALLPAPER_SETTINGS,
  DEFAULT_WALLPAPER_TEXTURE,
  WALLPAPER_MAX_FPS,
  WALLPAPER_MIN_FPS,
  WALLPAPER_PALETTES,
  frameRateOf,
  occludedFpsOf,
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
const activeRates = ref<Record<string, number>>({});
const activeReasons = ref<Record<string, string>>({});

const contentModeOptions = [
  { label: '跟随播放页', value: 'follow' },
  { label: '仅歌词', value: 'lyric' },
];
const pauseOptions = [
  { label: '暂停壁纸', value: 'freeze' },
  { label: '关闭壁纸', value: 'hide' },
];
// 绘制帧率按屏各配一份：滑杆就摆在这一屏的开关左边，改的是哪块屏一目了然。
// 轨道固定铺满 30–240，但真正能拖到多少卡在这块屏的刷新率上（拖不上去）。
const maxRateOf = (display: WallpaperState['displays'][number]) => {
  const refresh = Number(display.refreshRate) || 0;
  return refresh > 0 ? Math.min(refresh, WALLPAPER_MAX_FPS) : WALLPAPER_MAX_FPS;
};
const rateOf = (display: WallpaperState['displays'][number]) =>
  Math.min(frameRateOf(settings.value, display.id), maxRateOf(display));
const setDisplayRate = (display: WallpaperState['displays'][number], value: number) => {
  const next = Math.max(
    WALLPAPER_MIN_FPS,
    Math.min(Math.round(Number(value) || 0), maxRateOf(display)),
  );
  // 只提交这一块屏的键：主进程按屏深合并，不会碰其它屏的帧率。
  void setSettings({ frameRates: { [display.id]: next } });
};
const formatFrameRate = (value: number) => `${value} 帧`;
// 一行三个数按「设定 → 节能 → 当前」排：先看你能调的，再看自动降的，最后看实际跑的。
const frameHint = (display: WallpaperState['displays'][number]) => {
  const rate = rateOf(display);
  // 没勾选这块屏时壁纸根本不在上面画，报「暂停」会让人以为是自己按了暂停。
  if (!displayIds.value.includes(display.id)) return `设定 ${rate} 帧 · 未在这块屏显示`;
  const live = activeRates.value[display.id] ?? 0;
  // 0 帧要分开说：被窗口挡住还是暂停播放，用户要做的事完全不一样。
  const still = () => {
    switch (activeReasons.value[display.id]) {
      case 'covered':
        return '被窗口挡住';
      case 'occluded':
        return '被遮挡';
      case 'fullscreen':
        return '全屏中';
      default:
        return '暂停';
    }
  };
  return `设定 ${rate} 帧 · 节能 ${occludedFpsOf(rate)} 帧 · 当前 ${live > 0 ? `${live} 帧` : still()}`;
};
// 「仅歌词」画面质感的可调参数：中心压暗、边缘压暗、压暗曲线与粒子数量/大小
type TextureNumericKey =
  'centerDim' | 'edgeDim' | 'curve' | 'particleDensity' | 'particleSize' | 'particleSpeed';

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
    key: 'centerDim',
    group: 'dim',
    label: '压暗中心',
    hint: '屏幕中心的压暗效果',
    min: 0,
    max: 100,
    step: 1,
    unit: 'percent',
  },
  {
    key: 'edgeDim',
    group: 'dim',
    label: '压暗边缘',
    hint: '屏幕边缘的压暗效果',
    min: 0,
    max: 100,
    step: 1,
    unit: 'percent',
  },
  {
    key: 'curve',
    group: 'dim',
    label: '压暗曲线',
    hint: '屏幕中心到边缘的压暗变化曲率',
    min: 0,
    max: 100,
    step: 1,
    unit: 'percent',
  },
  {
    key: 'particleDensity',
    group: 'particle',
    label: '浮尘数量',
    hint: '画面里飘动的尘埃数量',
    min: 0,
    max: 200,
    step: 5,
    unit: 'percent',
  },
  {
    key: 'particleSize',
    group: 'particle',
    label: '浮尘大小',
    hint: '画面里飘动的尘埃大小',
    min: 0,
    max: 200,
    step: 5,
    unit: 'percent',
  },
  {
    key: 'particleSpeed',
    group: 'particle',
    label: '浮尘速度',
    hint: '画面里飘动尘埃的运动速度',
    min: 0,
    max: 200,
    step: 5,
    unit: 'percent',
  },
];

// 界面上按百分比/像素显示，存进设置里的仍是原始单位
const KNOB_SCALE: Record<string, number> = {
  centerDim: 100,
  edgeDim: 100,
  curve: 100,
  particleDensity: 100,
  particleSize: 100,
  particleSpeed: 100,
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
    (!nearSlider(current.centerDim, defaults.centerDim) ||
      !nearSlider(current.edgeDim, defaults.edgeDim) ||
      !nearSlider(current.curve, defaults.curve))
  ) {
    return true;
  }
  return (
    current.particleEnabled &&
    (!nearSlider(current.particleDensity, defaults.particleDensity) ||
      !nearSlider(current.particleSize, defaults.particleSize) ||
      !nearSlider(current.particleSpeed, defaults.particleSpeed))
  );
});

// 只把已打开的那一组拉回默认值，不会顺手把没开的开关打开；
// 壁纸穿透不跟压暗走，一并复位成默认（关闭）
const resetTexture = () => {
  const current = currentTexture.value;
  const defaults = DEFAULT_WALLPAPER_TEXTURE;
  const next: WallpaperTextureSettings = { ...current };
  if (current.dimEnabled) {
    next.centerDim = defaults.centerDim;
    next.edgeDim = defaults.edgeDim;
    next.curve = defaults.curve;
  }
  if (current.particleEnabled) {
    next.particleDensity = defaults.particleDensity;
    next.particleSize = defaults.particleSize;
    next.particleSpeed = defaults.particleSpeed;
  }
  next.passthroughEnabled = defaults.passthroughEnabled;
  void setSettings({ texture: next });
};

let alive = true;
let receivedState = false;
let disposeState: (() => void) | undefined;

// 持久化的名单里可能留着已经不存在的屏幕（换缩放、重挂、重启都会换号）。
// 界面只认当前真实存在的屏幕：否则每块屏都会判成「关」，而壁纸其实还在画。
// 名单整体失效时按主屏算 —— 壁纸的回落行为也是主屏，界面必须和它一致。
const displayIds = computed(() => {
  const alive = new Set(displays.value.map((display) => display.id));
  const selected = (settings.value.displayIds ?? []).filter((id) => alive.has(id));
  if (selected.length > 0) return selected;
  const primary = displays.value.find((display) => display.primary);
  return primary ? [primary.id] : [];
});
// 只有一块屏幕时按屏开关没有任何含义，整块不渲染（不是置灰）。
const multiDisplay = computed(() => displays.value.length > 1);
// 每一项换行都要解释清楚，否则用户只能靠猜。
const contentModeHint = computed(() => {
  switch (settings.value.contentMode) {
    case 'lyric':
      return '保留当前皮肤的歌词样式，去掉背景和封面';
    default:
      return '与播放页完全一致，含皮肤与视图模式';
  }
});
// 提示语只讲当前选中的那一档，两档混在一起看反而要猜。
const pauseHint = computed(() =>
  settings.value.pauseBehavior === 'hide' ? '暂停播放后收起壁纸' : '暂停播放后画面暂停',
);

const applyState = (state: WallpaperState) => {
  if (!alive) return;
  enabled.value = Boolean(state.enabled);
  if (state.settings) settings.value = state.settings;
  displays.value = Array.isArray(state.displays) ? state.displays : [];
  activeRates.value = state.activeFrameRates ?? {};
  activeReasons.value = state.activeReasons ?? {};
  // 顶部那行只留报错：正常状态不写文案，这里把上一次的报错清掉。
  message.value = '';
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
  // 逐屏字段必须深合：浅合并会把别的屏的键整个抹掉，那一行会瞬间跳回默认值。
  settings.value = {
    ...settings.value,
    ...patch,
    frameRates: { ...settings.value.frameRates, ...(patch.frameRates ?? {}) },
    texture: { ...settings.value.texture, ...(patch.texture ?? {}) },
  };
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
  // 基数必须是「当前真实存在的选中屏」，不能拿持久化名单：
  // 那份名单里混着失效 id，按它 append 只会越点越长，永远勾不上。
  const current = displayIds.value;
  if (value) {
    void setSettings({ displayIds: [...current.filter((item) => item !== id), id] });
    return;
  }
  const next = current.filter((item) => item !== id);
  // 关掉的是唯一选中的那块屏：壁纸总得有地方画，于是切到另一块（主屏优先），
  // 而不是把开关禁掉——禁掉的话用户会陷在「明明只有这一块能关，却点不动」的死角里。
  if (next.length === 0) {
    const fallback =
      displays.value.find((display) => display.id !== id && display.primary) ??
      displays.value.find((display) => display.id !== id);
    if (!fallback) return;
    void setSettings({ displayIds: [fallback.id] });
    return;
  }
  void setSettings({ displayIds: next });
};
const displayLabel = (display: WallpaperState['displays'][number]) =>
  `${display.width} × ${display.height}${display.primary ? ' · 主屏' : ''}${
    Number(display.refreshRate) > 0 ? ` · ${display.refreshRate}Hz` : ''
  }`;
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
          v-if="message"
          id="wallpaper-status"
          role="status"
          aria-live="polite"
          class="text-sm text-text-secondary"
        >
          {{ message }}
        </p>
      </div>
      <div class="flex items-center gap-3 shrink-0">
        <Switch
          aria-label="启用动态歌词壁纸"
          :model-value="enabled"
          :disabled="busy"
          @update:model-value="setEnabled(Boolean($event))"
        />
      </div>
    </div>
    <!-- 关闭壁纸时下面的细项没有意义，收起来保持界面干净 -->
    <template v-if="enabled">
      <!-- 一屏一行：档位滑杆就在这一屏的开关左边，改的是哪块屏不用猜 -->
      <div v-for="display in displays" :key="display.id" class="settings-item">
        <div class="min-w-0 flex-1 space-y-1">
          <h3 class="font-semibold">{{ display.label }}</h3>
          <p class="text-sm text-text-secondary">{{ displayLabel(display) }}</p>
          <p class="text-sm text-text-secondary">{{ frameHint(display) }}</p>
        </div>
        <Slider
          class="shrink-0 w-45"
          :aria-label="`${display.label} 绘制帧率`"
          :model-value="rateOf(display)"
          :min="WALLPAPER_MIN_FPS"
          :max="WALLPAPER_MAX_FPS"
          :step="1"
          :format-value="formatFrameRate"
          :bubble="true"
          :disabled="!displayIds.includes(display.id)"
          @update:model-value="setDisplayRate(display, Number($event))"
        />
        <Switch
          v-if="multiDisplay"
          :aria-label="`在${display.label}显示壁纸`"
          :model-value="displayIds.includes(display.id)"
          @update:model-value="toggleDisplay(display.id, Boolean($event))"
        />
      </div>
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
        <!-- 壁纸穿透是独立开关：不依赖压暗，压暗关掉时它照样决定桌面透不透 -->
        <div class="settings-item">
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
            <h3 class="font-semibold">压暗</h3>
            <p class="text-sm text-text-secondary">按当前壁纸配色压暗桌面</p>
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
        <div class="settings-item">
          <div class="min-w-0 flex-1 space-y-1">
            <h3 class="font-semibold">浮尘</h3>
            <p class="text-sm text-text-secondary">画面里随处飘动的尘埃，增加层次感</p>
          </div>
          <Switch
            aria-label="浮尘"
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
