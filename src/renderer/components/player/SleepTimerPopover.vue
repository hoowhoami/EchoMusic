<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import moon from '@iconify/icons-tabler/moon';
import power from '@iconify/icons-tabler/power';
import logout from '@iconify/icons-tabler/logout';
import playerPause from '@iconify/icons-tabler/player-pause';
import { iconCheck } from '@/icons';
import Button from '@/components/ui/Button.vue';
import Popover from '@/components/ui/Popover.vue';
import Switch from '@/components/ui/Switch.vue';
import { usePlayerStore } from '@/stores/player';
import { sleepTimerActionLabels, type SleepTimerAction } from '../../../shared/sleep-timer';

const player = usePlayerStore();
const open = ref(false);
const finishTrackId = useId();
const selected = ref<number | 'custom'>(30);
const customMinutes = ref<number | string>(45);
const selectedAction = ref<SleepTimerAction>('pause');
const actionLabel = computed(() => sleepTimerActionLabels[player.sleepTimer.action]);
const actionOptions = [
  { value: 'pause' as const, icon: playerPause, description: '保留当前歌曲与播放进度' },
  { value: 'quit' as const, icon: logout, description: '停止音乐并退出应用' },
  { value: 'shutdown' as const, icon: power, description: '停止音乐并关闭电脑' },
];
const shutdownSupported = ['darwin', 'win32', 'linux'].includes(window.electron?.platform ?? '');
const active = computed(() => player.sleepTimer.deadline !== null);
const busy = computed(() => player.sleepTimer.executing);
const waiting = computed(() => player.sleepTimer.waitingTrackId !== null);
const minutes = computed(() =>
  Number(selected.value === 'custom' ? customMinutes.value : selected.value),
);
const valid = computed(
  () => Number.isInteger(minutes.value) && minutes.value >= 1 && minutes.value <= 180,
);
const countdown = computed(() => {
  const seconds = player.sleepTimer.remainingSeconds;
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
});
const endTime = computed(() =>
  player.sleepTimer.deadline === null
    ? ''
    : new Date(player.sleepTimer.deadline).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
);
const triggerLabel = computed(() =>
  !active.value
    ? '定时关闭'
    : waiting.value
      ? `定时关闭 · 播完本首后${actionLabel.value}`
      : `定时关闭 · 剩余 ${countdown.value}后${actionLabel.value}`,
);
const syncSelection = (value: boolean) => {
  open.value = value;
  if (!value) return;
  selectedAction.value = player.sleepTimer.action;
  const duration = player.sleepTimer.durationMinutes;
  selected.value = [10, 20, 30, 60].includes(duration) ? duration : 'custom';
  if (selected.value === 'custom') customMinutes.value = duration;
};
const start = () => {
  if (valid.value) player.startSleepTimer(minutes.value, selectedAction.value);
};
const selectDuration = (duration: number | 'custom') => {
  if (busy.value || selected.value === duration) return;
  selected.value = duration;
  if (active.value && duration !== 'custom') {
    player.startSleepTimer(duration, player.sleepTimer.action);
  }
};
const applyCustomDuration = () => {
  if (active.value && selected.value === 'custom' && valid.value && !busy.value) {
    player.startSleepTimer(minutes.value, player.sleepTimer.action);
  }
};
const selectAction = (action: SleepTimerAction) => {
  if (busy.value) return;
  selectedAction.value = action;
  if (active.value) player.setSleepTimerAction(action);
};
</script>

<template>
  <Popover
    trigger="hover"
    :open="open"
    align="center"
    :side-offset="8"
    :show-arrow="true"
    content-class="sleep-timer-popover"
    @update:open="syncSelection"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="sleep-timer-trigger relative p-2 transition-all hover:scale-110 active:scale-90"
        :class="
          active ? 'text-primary-text bar-func-active' : 'text-text-main/50 hover:text-primary-text'
        "
        :aria-label="triggerLabel"
        :aria-expanded="open"
        aria-haspopup="dialog"
      >
        <Icon :icon="moon" width="20" height="20" />
        <span v-if="active" class="sleep-timer-dot" />
      </Button>
    </template>

    <section class="sleep-timer-panel" aria-label="定时关闭" @keydown.esc="open = false">
      <header class="flex items-center gap-3">
        <div class="sleep-timer-moon"><Icon :icon="moon" width="22" height="22" /></div>
        <div class="flex-1">
          <h2 class="text-[15px] font-bold">定时关闭</h2>
          <p class="text-[11px] opacity-50 mt-0.5">让音乐陪你入睡</p>
        </div>
      </header>

      <form @submit.prevent="start">
        <div class="sleep-timer-columns">
          <fieldset class="sleep-timer-time" :disabled="busy">
            <div class="sleep-timer-status" :class="{ 'is-active': active }">
              <template v-if="active">
                <span class="text-[11px] opacity-60">{{
                  waiting ? '时间到了，晚安' : `距离${actionLabel}还有`
                }}</span>
                <strong class="sleep-timer-countdown" :class="{ 'is-waiting': waiting }">{{
                  waiting ? '等待本首结束' : countdown
                }}</strong>
                <span class="text-[11px] opacity-55">{{
                  waiting
                    ? `本首结束后${actionLabel}`
                    : `预计 ${endTime}${player.sleepTimer.finishTrack ? ' 后，播完本首' : ' '}${actionLabel}`
                }}</span>
              </template>
              <template v-else>
                <span class="text-[13px] font-semibold">今晚，听多久？</span>
                <span class="text-[11px] opacity-50 mt-1">选择时长与到时动作</span>
              </template>
            </div>

            <div class="space-y-3">
              <div class="sleep-timer-presets" role="group" aria-label="定时时长">
                <button
                  v-for="duration in [10, 20, 30, 60]"
                  :key="duration"
                  type="button"
                  class="sleep-timer-preset app-focus-ring-soft"
                  :class="{ 'is-selected': selected === duration }"
                  :aria-pressed="selected === duration"
                  @click="selectDuration(duration)"
                >
                  <span class="text-[17px] font-bold tabular-nums">{{
                    duration === 60 ? 1 : duration
                  }}</span>
                  <span class="text-[10px] opacity-60">{{
                    duration === 60 ? '小时' : '分钟'
                  }}</span>
                </button>
              </div>
              <button
                type="button"
                class="sleep-timer-custom app-focus-ring-soft"
                :class="{ 'is-selected': selected === 'custom' }"
                :aria-pressed="selected === 'custom'"
                @click="selectDuration('custom')"
              >
                <span>自定义时长</span>
                <Icon v-if="selected === 'custom'" :icon="iconCheck" width="16" height="16" />
                <span v-else class="text-[11px] opacity-40">1–180 分钟</span>
              </button>
              <div v-if="selected === 'custom'">
                <label class="sleep-timer-input-row">
                  <input
                    v-model="customMinutes"
                    @change="applyCustomDuration"
                    type="number"
                    min="1"
                    max="180"
                    step="1"
                    required
                    aria-label="自定义分钟数"
                    :aria-invalid="!valid"
                    class="app-focus-ring-soft"
                  />
                  <span class="text-[12px] opacity-60">分钟后执行</span>
                </label>
                <p v-if="!valid" class="text-[11px] mt-1 text-[var(--state-danger)]">
                  请输入 1–180 之间的整数
                </p>
              </div>
            </div>
          </fieldset>
          <div class="sleep-timer-actions">
            <h3 class="text-[11px] font-semibold opacity-50 mb-2">到时动作</h3>
            <div class="space-y-2" role="group" aria-label="到时动作">
              <button
                v-for="option in actionOptions"
                :key="option.value"
                type="button"
                class="sleep-timer-action app-focus-ring-soft"
                :class="{ 'is-selected': selectedAction === option.value }"
                :aria-pressed="selectedAction === option.value"
                :disabled="busy || (option.value === 'shutdown' && !shutdownSupported)"
                @click="selectAction(option.value)"
              >
                <Icon :icon="option.icon" width="18" height="18" />
                <span class="flex-1 text-left">
                  <span class="block text-[12px] font-semibold">{{
                    sleepTimerActionLabels[option.value]
                  }}</span>
                  <span class="block text-[10px] opacity-50 mt-1">{{ option.description }}</span>
                </span>
                <Icon
                  v-if="selectedAction === option.value"
                  :icon="iconCheck"
                  width="16"
                  height="16"
                />
              </button>
            </div>
            <div class="sleep-timer-finish">
              <div>
                <label :for="finishTrackId" class="text-[12px] font-semibold"
                  >播完整首歌再执行</label
                >
                <p class="text-[10px] opacity-45 mt-1">到时不打断正在播放的歌曲</p>
              </div>
              <Switch
                :id="finishTrackId"
                :model-value="player.sleepTimer.finishTrack"
                aria-label="播完整首歌再执行"
                :disabled="busy"
                @update:model-value="player.setSleepTimerFinishTrack"
              />
            </div>
          </div>
        </div>
        <p v-if="player.sleepTimer.error" role="alert" class="sleep-timer-error">
          {{ player.sleepTimer.error }}
        </p>
        <div class="sleep-timer-footer">
          <span class="text-[11px] opacity-50 flex-1">{{
            player.sleepTimer.executing
              ? `正在请求${actionLabel}…`
              : active
                ? `当前定时：${actionLabel}`
                : '设置好后，安心听歌'
          }}</span>
          <Button
            v-if="active"
            variant="secondary"
            size="sm"
            type="button"
            class="shrink-0"
            @click="player.cancelSleepTimer"
            >取消定时</Button
          >
          <Button
            variant="primary"
            size="sm"
            type="submit"
            :disabled="!valid || busy"
            :loading="busy"
            >{{ active ? '重新计时' : '开启定时' }}</Button
          >
        </div>
      </form>
    </section>
  </Popover>
</template>

<style>
.sleep-timer-popover.echo-popover-content {
  width: min(596px, calc(100vw - 24px));
  padding: 20px;
  color: var(--color-text-main);
}
</style>

<style scoped>
.sleep-timer-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 22px;
  margin-top: 18px;
}
.sleep-timer-time,
.sleep-timer-actions {
  min-width: 0;
}
.sleep-timer-actions {
  padding-left: 22px;
  border-left: 1px solid var(--border-subtle);
}
.sleep-timer-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  cursor: pointer;
}
.sleep-timer-action:hover {
  background: var(--control-hover-bg);
}
.sleep-timer-action.is-selected {
  color: var(--color-primary-text);
  border-color: color-mix(in srgb, var(--color-primary) 48%, transparent);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
}
.sleep-timer-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sleep-timer-error {
  color: var(--state-danger);
  font-size: 11px;
  margin-top: 12px;
  overflow-wrap: anywhere;
  max-height: 64px;
  overflow: auto;
}
.sleep-timer-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  border-top: 1px solid var(--border-subtle);
  margin-top: 16px;
  padding-top: 14px;
}
@media (max-width: 540px) {
  .sleep-timer-columns {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .sleep-timer-actions {
    border-left: 0;
    padding-left: 0;
  }
  .sleep-timer-footer {
    flex-wrap: wrap;
  }
}
.sleep-timer-dot {
  position: absolute;
  right: 5px;
  top: 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-primary);
}
.sleep-timer-moon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 14px;
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}
.sleep-timer-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 108px;
  margin: 0 0 16px;
  padding: 14px 8px;
  border-radius: 14px;
  background: var(--control-muted-bg);
}
.sleep-timer-status.is-active {
  background: color-mix(in srgb, var(--color-primary) 7%, var(--color-bg-elevated));
}
.sleep-timer-countdown {
  font-size: 36px;
  line-height: 1.3;
  font-weight: 650;
  letter-spacing: 1px;
  font-variant-numeric: tabular-nums;
  color: var(--color-primary-text);
}
.sleep-timer-countdown.is-waiting {
  font-size: 21px;
  letter-spacing: 0;
  margin: 7px 0;
}
.sleep-timer-presets {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.sleep-timer-preset {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 10px 0;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  transition:
    background 150ms,
    border-color 150ms;
  cursor: pointer;
}
.sleep-timer-custom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  font-size: 12px;
  cursor: pointer;
}
.sleep-timer-preset:hover,
.sleep-timer-custom:hover {
  background: var(--control-hover-bg);
}
.sleep-timer-preset.is-selected,
.sleep-timer-custom.is-selected {
  color: var(--color-primary-text);
  border-color: color-mix(in srgb, var(--color-primary) 48%, transparent);
  background: color-mix(in srgb, var(--color-primary) 9%, transparent);
}
.sleep-timer-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sleep-timer-input-row input {
  width: 104px;
  padding: 8px 12px;
  border: 1px solid var(--control-border);
  border-radius: 10px;
  background: var(--control-muted-bg);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}
.sleep-timer-finish {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  padding: 14px 0;
  border-top: 1px solid var(--border-subtle);
}
</style>
