<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useSettingStore } from '@/stores/setting';
import Slider from '@/components/ui/Slider.vue';
import { kugouVerificationState } from '@/utils/kugouVerification';
import type { CommentSendResource } from '@/api/comment';
import Button from '@/components/ui/Button.vue';
import Switch from '@/components/ui/Switch.vue';
import Popover from '@/components/ui/Popover.vue';
import CommentComposer from './CommentComposer.vue';
import BarrageIcon from '@/components/ui/BarrageIcon.vue';
import { iconX } from '@/icons';
const props = defineProps<{ resource: CommentSendResource; variant?: 'lyric' }>();
const settings = useSettingStore();
const config = computed(() =>
  props.variant === 'lyric' ? settings.lyricBarrageConfig : settings.mvBarrageConfig,
);
const enabled = defineModel<boolean>({ default: false });
const emit = defineEmits<{ sent: [content: string] }>();
const open = ref(false);
// 验证弹窗会关闭并卸载 Popover 内容，草稿和发送状态必须由外层保留。
const draft = ref('');
const sending = ref(false);
let resumeComposer = false;
watch(
  () => kugouVerificationState.open,
  (verifying) => {
    if (verifying && sending.value && open.value) {
      resumeComposer = true;
      open.value = false;
    }
  },
);
watch(sending, (busy) => {
  if (!busy && resumeComposer) {
    resumeComposer = false;
    open.value = true;
  }
});
function handleSent(content: string) {
  resumeComposer = false;
  open.value = false;
  emit('sent', content);
}
watch(
  () => props.resource.hash,
  () => {
    open.value = false;
    draft.value = '';
    resumeComposer = false;
  },
);
</script>

<template>
  <div
    class="barrage-toolbar no-drag"
    :class="{ 'is-lyric': variant === 'lyric', 'is-video': variant !== 'lyric' }"
  >
    <Popover
      v-model:open="open"
      trigger="click"
      :side="variant === 'lyric' ? 'top' : 'bottom'"
      align="end"
      :show-arrow="false"
      content-class="barrage-send-popover"
    >
      <template #trigger>
        <Button
          variant="unstyled"
          size="none"
          class="barrage-trigger"
          :class="{ 'is-active': enabled }"
          :disabled="!resource.hash || kugouVerificationState.open"
          :tooltip="enabled ? '弹幕已开启 · 设置与发送' : '弹幕已关闭 · 设置与发送'"
          aria-label="弹幕设置与发送"
        >
          <BarrageIcon width="20" height="20" />
          <template v-if="variant !== 'lyric'">
            <span>弹幕</span>
            <span class="barrage-trigger-status">{{ enabled ? '已开启' : '已关闭' }}</span>
          </template>
        </Button>
      </template>

      <div class="barrage-panel">
        <div class="barrage-panel-heading">
          <span class="barrage-panel-title"><BarrageIcon width="18" height="18" />弹幕</span>
          <Switch v-model="enabled" aria-label="显示弹幕" />
          <Button
            variant="unstyled"
            size="none"
            type="button"
            class="barrage-close"
            aria-label="关闭弹幕面板"
            @click="open = false"
          >
            <Icon :icon="iconX" width="16" height="16" />
          </Button>
        </div>
        <div class="barrage-panel-body">
          <div class="barrage-settings">
            <div class="barrage-setting">
              <div class="barrage-setting-label">
                <span>透明度</span><span>{{ config.opacity }}%</span>
              </div>
              <Slider
                v-model="config.opacity"
                :min="20"
                :max="100"
                :step="5"
                aria-label="弹幕透明度"
              />
            </div>
            <div class="barrage-setting">
              <div class="barrage-setting-label">
                <span>字号</span><span>{{ config.fontSize }} px</span>
              </div>
              <Slider
                v-model="config.fontSize"
                :min="12"
                :max="28"
                :step="1"
                aria-label="弹幕字号"
              />
            </div>
            <div class="barrage-setting">
              <div class="barrage-setting-label">
                <span>速度</span><span>{{ config.speed }}×</span>
              </div>
              <Slider
                v-model="config.speed"
                :min="0.5"
                :max="2"
                :step="0.25"
                aria-label="弹幕速度"
              />
            </div>
            <div class="barrage-setting">
              <div class="barrage-setting-label"><span>密度</span></div>
              <div class="barrage-area-options" role="group" aria-label="弹幕密度">
                <Button
                  v-for="option in [
                    { value: 1, label: '稀疏' },
                    { value: 2, label: '适中' },
                    { value: 3, label: '密集' },
                  ]"
                  :key="option.value"
                  variant="unstyled"
                  size="none"
                  :aria-pressed="config.density === option.value"
                  :class="{ selected: config.density === option.value }"
                  @click="config.density = option.value"
                  >{{ option.label }}</Button
                >
              </div>
            </div>
            <div class="barrage-setting">
              <div class="barrage-setting-label"><span>显示区域</span></div>
              <div class="barrage-area-options" role="group" aria-label="弹幕显示区域">
                <Button
                  v-for="option in [
                    { value: 25, label: '顶部' },
                    { value: 50, label: '上半屏' },
                    { value: 100, label: '全屏' },
                  ]"
                  :key="option.value"
                  variant="unstyled"
                  size="none"
                  :aria-pressed="config.area === option.value"
                  :class="{ selected: config.area === option.value }"
                  @click="config.area = option.value"
                  >{{ option.label }}</Button
                >
              </div>
            </div>
          </div>
          <CommentComposer
            class="barrage-panel-composer"
            v-model:content="draft"
            v-model:sending="sending"
            :resource="resource"
            variant="barrage"
            label="写下此刻的感受…"
            @sent="handleSent"
          />
        </div>
      </div>
    </Popover>
  </div>
</template>

<style scoped>
.barrage-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 12px 0;
  color: var(--text-main);
}
.barrage-toolbar :deep(button) {
  gap: 6px;
}
.barrage-toolbar.is-lyric {
  padding: 0;
}
.barrage-trigger {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  color: var(--text-secondary);
  transition: all 0.2s ease;
}
.barrage-trigger:hover {
  color: var(--text-main);
  transform: scale(1.1);
}
.barrage-trigger:active {
  transform: scale(0.9);
}
.barrage-trigger.is-active {
  color: var(--color-primary);
}
.barrage-toolbar.is-lyric :deep(.barrage-trigger) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  transition:
    color 0.2s ease,
    transform 0.2s ease;
  color: rgba(255, 255, 255, 0.4);
  border-radius: 5px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.25));
}
.barrage-toolbar.is-lyric :deep(.barrage-trigger svg) {
  color: inherit;
}
.barrage-toolbar.is-lyric :deep(.barrage-trigger:hover:not(:disabled)) {
  color: rgba(255, 255, 255, 0.9);
  transform: scale(1.1);
}
.barrage-toolbar.is-lyric :deep(.barrage-trigger:active:not(:disabled)) {
  transform: scale(0.9);
}
.barrage-toolbar.is-lyric :deep(.barrage-trigger.is-active) {
  color: #fff;
}
.barrage-toolbar.is-video :deep(.barrage-trigger) {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 6px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  background: var(--control-muted-bg);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  transform: none;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}
.barrage-toolbar.is-video :deep(.barrage-trigger:hover) {
  color: var(--text-main);
  background: var(--color-bg-elevated);
  border-color: color-mix(in srgb, var(--color-primary) 30%, var(--border-subtle));
}
.barrage-toolbar.is-video :deep(.barrage-trigger.is-active) {
  color: var(--color-primary-text);
  background: color-mix(in srgb, var(--color-primary) 10%, var(--color-bg-elevated));
  border-color: color-mix(in srgb, var(--color-primary) 22%, var(--border-subtle));
}
.barrage-trigger-status {
  padding-left: 8px;
  border-left: 1px solid var(--border-subtle);
  font-size: 11px;
  font-weight: 400;
}
.barrage-panel-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
  gap: 20px;
}
.barrage-settings {
  display: grid;
  gap: 12px;
  padding-right: 20px;
  border-right: 1px solid var(--border-subtle);
}
.barrage-panel-composer {
  min-width: 0;
  height: 100%;
}
.barrage-panel-composer :deep(textarea) {
  flex: 1;
  height: auto;
  min-height: 112px;
  max-height: none;
  resize: none;
}
.barrage-setting-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.barrage-area-options {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--control-muted-bg);
}
.barrage-area-options :deep(button) {
  flex: 1;
  padding: 5px 8px;
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
.barrage-area-options :deep(button.selected) {
  background: var(--color-bg-elevated);
  color: var(--color-primary-text);
  box-shadow: var(--shadow-sm);
}
.barrage-panel {
  width: min(600px, calc(100vw - 64px));
  color: var(--text-main);
}
.barrage-panel-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 0 14px;
  font-size: 14px;
  font-weight: 600;
}
.barrage-panel-title {
  flex: 1;
}
.barrage-panel-heading :deep(.barrage-close) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.barrage-panel-heading :deep(.barrage-close:hover) {
  background: var(--control-hover-bg);
  color: var(--text-main);
}
.barrage-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.barrage-panel-title svg {
  color: var(--text-secondary);
}
:global(.echo-popover-content.barrage-send-popover) {
  padding: 16px;
  border-radius: 16px;
  box-sizing: border-box;
  max-height: min(
    calc(100dvh - 32px),
    var(--reka-popover-content-available-height, calc(100dvh - 32px))
  );
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
@media (max-width: 620px) {
  .barrage-panel-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .barrage-settings {
    padding-right: 0;
    padding-bottom: 16px;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }
  .barrage-panel-composer {
    height: auto;
  }
}
</style>
