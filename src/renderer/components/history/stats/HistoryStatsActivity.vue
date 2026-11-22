<script setup lang="ts">
/**
 * 听歌统计活动区：35 天日历热力图 + 24 小时音乐时钟。
 * 移植自 EchoMusicNext HistoryStatsActivity.qml（含 HistoryStatsBar 的比例动画）。
 * 数据语义：每首歌只按「最后播放」的日期/时刻计入一次足迹。
 */
import { computed, ref } from 'vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { iconHeadphones } from '@/icons';
import type { HistoryStats } from '../../../../shared/historyStats';
import HistoryStatsPanel from './HistoryStatsPanel.vue';
import { useContainerWidth } from './useContainerWidth';
import './statsShared.css';

// animate 仅在模板中使用，无需 script 内引用
withDefaults(
  defineProps<{
    stats: HistoryStats;
    animate?: boolean;
  }>(),
  { animate: true },
);

const rootRef = ref<HTMLElement | null>(null);
const rootWidth = useContainerWidth(rootRef);
/** 双面板并排的最小宽度（对齐 Next stacked: 700） */
const stacked = computed(() => rootWidth.value < 700);

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const DIAL_MARKS = ['00', '06', '12', '18'];

/** 日历格底色：有足迹时按比例混入主题色（.18 + .72×ratio），否则用文字色 3.5% 的灰底 */
const dayBackground = (count: number, ratio: number) => {
  if (count > 0) {
    const p = 0.18 + 0.72 * ratio;
    return `color-mix(in srgb, var(--control-muted-bg) ${((1 - p) * 100).toFixed(1)}%, var(--color-primary) ${(p * 100).toFixed(1)}%)`;
  }
  return 'color-mix(in srgb, var(--text-main) 3.5%, transparent)';
};

/** 图例色块：.12 + index×.25 混色（对齐 Next） */
const legendColor = (index: number) => {
  const p = 0.12 + index * 0.25;
  return `color-mix(in srgb, var(--control-muted-bg) ${((1 - p) * 100).toFixed(1)}%, var(--color-primary) ${(p * 100).toFixed(1)}%)`;
};

/** 时钟指针条的比例：底噪 .16 + .84×数据比例（对齐 Next） */
const barRatio = (ratio: number) => 0.16 + 0.84 * ratio;
/** 指针条颜色：有足迹用主题色，否则用文字色 12% 的灰 */
const barTint = (count: number) =>
  count > 0 ? 'var(--color-primary)' : 'color-mix(in srgb, var(--text-main) 12%, transparent)';

const dayTooltipText = (day: { date: string; count: number }) =>
  `${day.count} 首歌曲最后播放于这一天`;
const hourTooltipTime = (hour: number) => `${hour}:00–${hour}:59`;
const hourTooltipText = (hour: { count: number }) => `${hour.count} 首歌曲的最后播放时段`;

/** 刻度方位：0 顶中 / 1 右中 / 2 底中 / 3 左中（对齐 Next） */
const markClass = (index: number) =>
  index === 0 ? 'is-top' : index === 1 ? 'is-right' : index === 2 ? 'is-bottom' : 'is-left';
</script>

<template>
  <div ref="rootRef" class="stats-activity" :class="{ stacked }">
    <HistoryStatsPanel
      heading="听歌留下的日常"
      :description="`${stats.calendarLabel} · 每首歌最后出现的日期`"
      :detail="`${stats.calendarSongs} 首足迹`"
      :animate="animate"
      :order="0"
      class="calendar-panel"
    >
      <div class="calendar-grid">
        <div v-for="label in WEEKDAY_LABELS" :key="label" class="calendar-head">{{ label }}</div>
        <Tooltip
          v-for="day in stats.calendarDays"
          :key="day.date"
          :content="day.date"
          :description="dayTooltipText(day)"
        >
          <div
            class="calendar-day"
            :class="{ today: day.today, future: day.future }"
            :style="{ background: dayBackground(day.count, day.ratio) }"
          >
            <span class="day-number" :class="{ 'is-peak': day.ratio > 0.6 }">{{ day.day }}</span>
          </div>
        </Tooltip>
      </div>
      <div class="calendar-legend">
        <span class="legend-text">颜色越深，留下的歌曲越多</span>
        <div class="legend-swatches">
          <div
            v-for="index in 4"
            :key="index"
            class="legend-swatch"
            :style="{ background: legendColor(index - 1) }"
          ></div>
        </div>
      </div>
    </HistoryStatsPanel>

    <HistoryStatsPanel
      heading="你的音乐时钟"
      description="24 小时 · 每首歌最后出现的时刻"
      :animate="animate"
      :order="1"
      class="clock-panel"
    >
      <div class="clock-frame">
        <div class="clock-dial">
          <div
            v-for="(hour, index) in stats.hourlyFootprint"
            :key="hour.hour"
            class="hour-spoke"
            :style="{ transform: `rotate(${index * 15}deg)` }"
          >
            <Tooltip :content="hourTooltipTime(hour.hour)" :description="hourTooltipText(hour)">
              <div class="hour-bar">
                <div
                  class="hour-bar-fill"
                  :style="{
                    height: `${barRatio(hour.ratio) * 100}%`,
                    background: barTint(hour.count),
                  }"
                ></div>
              </div>
            </Tooltip>
          </div>
          <div class="dial-center">
            <Icon :icon="iconHeadphones" width="23" height="23" class="dial-icon" />
            <div class="dial-peak">{{ stats.peakHourLabel || '—' }}</div>
            <div class="dial-caption">最密集的时刻</div>
          </div>
          <div
            v-for="(mark, index) in DIAL_MARKS"
            :key="mark"
            class="dial-mark"
            :class="markClass(index)"
          >
            {{ mark }}
          </div>
        </div>
      </div>
    </HistoryStatsPanel>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.stats-activity {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  gap: 30px 40px;
  min-width: 0;
}

.stats-activity.stacked {
  grid-template-columns: minmax(0, 1fr);
}

/* ── 日历 ───────────────────────────────── */
.calendar-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.calendar-head {
  height: 20px;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 500;
  line-height: 20px;
  text-align: center;
}

.calendar-day {
  position: relative;
  height: 35px;
  border-radius: 5px;
}

.calendar-day.today {
  box-shadow: inset 0 0 0 1px var(--color-primary-text);
}

.calendar-day.future {
  opacity: 0.25;
}

.day-number {
  position: absolute;
  inset: 0;
  color: var(--color-text-main);
  font-size: 11px;
  font-weight: 500;
  line-height: 35px;
  text-align: center;
}

.day-number.is-peak {
  color: var(--color-on-primary);
}

.day-number.today {
  font-weight: 700;
}

.calendar-legend {
  display: flex;
  align-items: center;
  gap: 5px;
}

.legend-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 400;
}

.legend-swatches {
  display: flex;
  gap: 5px;
}

.legend-swatch {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

/* ── 音乐时钟 ───────────────────────────── */
.clock-frame {
  position: relative;
  height: 244px;
  width: 100%;
}

.clock-dial {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 244px;
  height: 244px;
  transform: translate(-50%, -50%);
}

.hour-spoke {
  position: absolute;
  top: calc(50% - 100px);
  left: calc(50% - 4px);
  width: 8px;
  height: 100px;
  transform-origin: 50% 100%;
}

.hour-bar {
  position: relative;
  width: 6px;
  height: 29px;
}

.hour-bar-fill {
  position: absolute;
  bottom: 0;
  width: 100%;
  border-radius: 3px;
  /* 首次渲染按比例生长，之后数据变化由 transition 平滑过渡（对齐 Next HistoryStatsBar） */
  animation: hourBarGrow 240ms cubic-bezier(0.2, 0, 0, 1);
  transition: height 240ms cubic-bezier(0.2, 0, 0, 1);
}

@keyframes hourBarGrow {
  from {
    height: 0;
  }
}

.dial-center {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  transform: translate(-50%, -50%);
}

.dial-icon {
  color: var(--color-primary-text);
}

.dial-peak {
  color: var(--color-text-main);
  font-size: 25px;
  font-weight: 600;
  line-height: 1.2;
}

.dial-caption {
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 400;
}

.dial-mark {
  position: absolute;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
}

.dial-mark.is-top {
  top: 0;
  left: 50%;
  transform: translateX(-50%);
}

.dial-mark.is-right {
  top: 50%;
  right: 0;
  transform: translateY(-50%);
}

.dial-mark.is-bottom {
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
}

.dial-mark.is-left {
  top: 50%;
  left: 0;
  transform: translateY(-50%);
}
</style>
