<script setup lang="ts">
import type { Directive } from 'vue';
import { computed, onActivated, onDeactivated, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useDocumentVisibility } from '@vueuse/core';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import {
  normalizeBarrageItems,
  normalizeBarrageUserId,
  getFreeBarrageLane,
  barrageTravelDuration,
  barrageIdentity,
  nextBarrageItem,
  type BarrageItem,
} from '@/utils/barrage';
import { getBarrage } from '@/api/comment';
// 在节点插入后测量一次真实宽度（含字体、内边距和边框），不逐帧读取布局。
// 起点、距离与时长使用同一次测量，窗口变化也不会让正在飞行的弹幕突然加速。
const vFlightMotion: Directive<HTMLElement, number> = {
  mounted(element, binding) {
    const width = element.parentElement?.getBoundingClientRect().width ?? 0;
    const textWidth = element.getBoundingClientRect().width;
    element.style.left = `${width}px`;
    element.style.setProperty('--barrage-distance', `${width + textWidth}px`);
    element.style.animationDuration = `${barrageTravelDuration(width, textWidth, binding.value)}s`;
  },
};
const props = defineProps<{
  type: 'song' | 'video';
  hash: string;
  name?: string;
  playing: boolean;
}>();
const settings = useSettingStore();
const config = computed(() =>
  props.type === 'song' ? settings.lyricBarrageConfig : settings.mvBarrageConfig,
);
const enabled = defineModel<boolean>('enabled', { default: false });
// 改变几何和速度时重建飞行轨迹，避免正在播放的 CSS 动画突然跳位。
watch(
  () => [config.value.fontSize, config.value.speed, config.value.area],
  () => {
    flights.value = [];
  },
);
const active = ref(true);
const loading = ref(false);
const error = ref('');
const userStore = useUserStore();
const visibility = useDocumentVisibility();
const currentUserId = computed(() =>
  userStore.isLoggedIn ? normalizeBarrageUserId(userStore.info?.userid) : '',
);
const items = shallowRef<BarrageItem[]>([]);
const flights = ref<(BarrageItem & { id: number; lane: number })[]>([]);
const pendingOwn = ref<BarrageItem[]>([]);
const recentOwn = new Map<string, number>();
let generation = 0;
let cursor = 0;
let sequence = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const running = computed(
  () =>
    enabled.value &&
    active.value &&
    props.playing &&
    visibility.value === 'visible' &&
    (items.value.length > 0 || pendingOwn.value.length > 0 || flights.value.length > 0),
);
async function load(preservePlayback = false) {
  if (preservePlayback && (!enabled.value || !active.value || !props.hash)) return;
  const token = ++generation;
  if (!preservePlayback) {
    items.value = [];
    flights.value = [];
    cursor = 0;
    pendingOwn.value = [];
    recentOwn.clear();
  }
  error.value = '';
  loading.value = false;
  if (!enabled.value || !active.value || !props.hash) return;
  loading.value = !preservePlayback || items.value.length === 0;
  try {
    const response = await getBarrage(props.type, props.hash);
    if (token !== generation) return;
    const updated = normalizeBarrageItems(response.list);
    if (preservePlayback && items.value.length) {
      // 请求期间仍在发射弹幕，按响应到达时的下一条对齐，不能使用请求前的游标。
      // 审核中暂时返回空列表时保留当前播放池。
      if (!updated.length) return;
      const next = items.value[cursor % items.value.length];
      const nextIndex = updated.findIndex(
        (item) => item.text === next.text && item.userId === next.userId,
      );
      cursor = nextIndex >= 0 ? nextIndex : cursor % updated.length;
    }
    items.value = updated;
  } catch (e) {
    if (token === generation && (!preservePlayback || !items.value.length)) {
      error.value = e instanceof Error ? e.message : '弹幕加载失败';
    }
  } finally {
    if (token === generation) loading.value = false;
  }
}
watch(
  [() => props.hash, () => props.type, enabled, active],
  () => {
    void load();
  },
  { immediate: true },
);
function launchNext(onlyOwn = false) {
  if (!running.value) return;
  const lane = getFreeBarrageLane(flights.value);
  if (lane < 0) return;
  let item = pendingOwn.value.shift();
  if (item) {
    recentOwn.set(
      barrageIdentity(item),
      Date.now() + Math.max(20000, 10000 / config.value.speed + 5000),
    );
  } else if (!onlyOwn) {
    // 长弹幕仍在屏幕上时，继续抑制它的接口回流副本。
    for (const flight of flights.value) {
      const key = barrageIdentity(flight);
      if (recentOwn.has(key)) recentOwn.set(key, Date.now() + 5000);
    }
    const next = nextBarrageItem(items.value, cursor, recentOwn, Date.now());
    cursor = next.cursor;
    item = next.item;
  }
  if (item) flights.value.push({ ...item, id: ++sequence, lane });
}
function finishFlight(id: number) {
  flights.value = flights.value.filter((item) => item.id !== id);
  launchNext(true);
}
function onSent(content: string) {
  if (!enabled.value || !active.value || !props.hash || !content.trim()) return;
  pendingOwn.value.push({ text: content.trim(), userId: currentUserId.value });
  launchNext(true);
  void load(true);
}
watch(
  [running, () => config.value.density],
  ([value]) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (value)
      timer = setInterval(
        () => launchNext(),
        config.value.density === 1 ? 4500 : config.value.density === 3 ? 1400 : 2800,
      );
  },
  { immediate: true },
);
onActivated(() => {
  active.value = true;
});
onDeactivated(() => {
  active.value = false;
});
onBeforeUnmount(() => {
  generation++;
  if (timer) clearInterval(timer);
});
defineExpose({ onSent });
</script>

<template>
  <div class="barrage-layer" :class="{ paused: !running }">
    <div
      v-if="enabled"
      class="barrage-flight-area"
      aria-hidden="true"
      :style="{
        height: `calc(${config.area}% - 24px)`,
        minHeight: `${(config.fontSize * 1.4 + 8) * 4}px`,
        opacity: config.opacity / 100,
      }"
    >
      <span
        v-for="flight in flights"
        :key="flight.id"
        v-flight-motion="config.speed"
        class="barrage-flight"
        :class="{ 'is-own': Boolean(currentUserId) && flight.userId === currentUserId }"
        :style="{
          top: `calc(${flight.lane * 25}% + 2px)`,
          fontSize: `${config.fontSize}px`,
          lineHeight: '1.4',
        }"
        @animationend="finishFlight(flight.id)"
        >{{ flight.text }}</span
      >
    </div>
    <div
      v-if="enabled && !flights.length && !pendingOwn.length && (loading || error || !items.length)"
      class="barrage-status"
      role="status"
    >
      {{ loading ? '弹幕加载中…' : error ? '弹幕加载失败，请关闭后重新开启' : '暂无弹幕' }}
    </div>
  </div>
</template>

<style scoped>
.barrage-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 5;
  overflow: hidden;
}
.barrage-flight-area {
  position: absolute;
  left: 0;
  right: 0;
  top: 24px;
  height: calc(25% - 24px);
  overflow: hidden;
}
.barrage-flight {
  position: absolute;
  left: 100%;
  white-space: nowrap;
  color: white;
  font-size: 17px;
  line-height: 24px;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  text-shadow:
    0 1px 3px #000,
    1px 0 2px #000;
  animation: barrage-fly 10s linear forwards;
}
.barrage-flight.is-own {
  border-color: rgba(255, 255, 255, 0.9);
  background: rgba(0, 0, 0, 0.2);
}
.paused .barrage-flight {
  animation-play-state: paused;
}
.barrage-status {
  position: absolute;
  right: 20px;
  top: 100px;
  color: white;
  opacity: 0.65;
  font-size: 12px;
  text-shadow: 0 1px 3px #000;
}
@keyframes barrage-fly {
  to {
    transform: translateX(calc(-1 * var(--barrage-distance)));
  }
}
@media (prefers-reduced-motion: reduce) {
  .barrage-flight {
    left: 12px !important;
    animation-name: barrage-fade;
  }
}
@keyframes barrage-fade {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
</style>
