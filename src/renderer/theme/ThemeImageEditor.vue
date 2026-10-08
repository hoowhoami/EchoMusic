<script setup lang="ts">
import { ref } from 'vue';
import Button from '@/components/ui/Button.vue';
import Slider from '@/components/ui/Slider.vue';
import { Icon } from '@iconify/vue';
import { iconImage } from '@/icons';
import ThemeImageCropper from './ThemeImageCropper.vue';
import type { ThemeOverride } from './model';
import type { ImageSize } from './imageCrop';

defineProps<{
  image: string;
  hasImage: boolean;
  background: ThemeOverride['background'];
  viewport: ImageSize;
  shell?: string;
  importing: boolean;
  canReset: boolean;
  canCancel: boolean;
  canApply: boolean;
  error: string;
}>();
const emit = defineEmits<{
  change: [patch: Partial<ThemeOverride['background']>];
  error: [message: string];
  chooseImage: [];
  selectImage: [file: File | undefined];
  chooseTextColor: [];
  reset: [];
  cancel: [];
  apply: [];
}>();
const cropper = ref<InstanceType<typeof ThemeImageCropper> | null>(null);
const apply = () => {
  if (cropper.value?.commitSelection()) emit('apply');
};
</script>

<template>
  <section class="theme-image-editor" aria-label="自定义背景编辑">
    <div class="theme-image-editor-body">
      <div class="theme-image-editor-workspace">
        <div
          class="theme-image-editor-canvas"
          :class="{ 'has-image': hasImage }"
          @dragover.prevent
          @drop.prevent="emit('selectImage', $event.dataTransfer?.files[0])"
        >
          <ThemeImageCropper
            ref="cropper"
            v-if="image"
            :image="image"
            :background="background"
            :viewport="viewport"
            :shell="shell"
            :disabled="importing"
            @change="emit('change', $event)"
            @error="emit('error', $event)"
          />
          <div
            v-else-if="importing || (hasImage && !error)"
            class="theme-image-editor-loading"
            role="status"
          >
            正在加载图片…
          </div>
          <div v-else class="theme-image-editor-empty">
            <Icon :icon="iconImage" :width="32" />
            <h2>选择背景图片</h2>
            <Button variant="secondary" size="sm" @click="emit('chooseImage')">选择本地图片</Button>
            <p>或拖入 JPG、PNG、WebP 图片，不超过 20 MB</p>
          </div>
          <div v-if="hasImage" class="theme-image-editor-image-actions">
            <Button
              variant="secondary"
              size="sm"
              :disabled="importing || !image"
              @click="cropper?.selectWholeImage()"
              >选取整张图片</Button
            >
            <Button
              variant="secondary"
              size="sm"
              :disabled="importing"
              @click="emit('chooseImage')"
            >
              {{ importing ? '正在导入…' : '重新选图' }}
            </Button>
          </div>
        </div>
        <aside class="theme-image-editor-settings" aria-label="背景设置">
          <div class="theme-image-editor-color">
            <label>文字颜色</label>
            <button
              type="button"
              aria-label="选择背景文字颜色"
              :disabled="importing || !image"
              @click="emit('chooseTextColor')"
            >
              <i :style="{ background: background.textColor }" />
              <span>{{ background.textColor.toUpperCase() }}</span>
            </button>
          </div>
          <div
            v-for="control in [
              { key: 'shade', title: '背景遮罩', max: 85 },
              { key: 'panelOpacity', title: '右侧面板遮罩', max: 100 },
            ] as const"
            :key="control.key"
            class="theme-image-editor-range"
          >
            <label
              >{{ control.title }}<output>{{ Math.round(background[control.key]) }}%</output></label
            >
            <Slider
              :model-value="background[control.key]"
              :max="control.max"
              :aria-label="control.title"
              :disabled="importing || !image"
              @update:model-value="emit('change', { [control.key]: $event })"
            />
          </div>
          <p class="theme-image-editor-hint">裁剪后的区域将拉伸铺满页面。</p>
        </aside>
      </div>
      <p v-if="error" class="theme-image-editor-error" role="alert">{{ error }}</p>
    </div>
    <footer class="theme-image-editor-footer">
      <Button
        variant="secondary"
        size="sm"
        class="theme-image-editor-reset"
        :disabled="importing || !canReset"
        @click="emit('reset')"
        >恢复默认</Button
      >
      <div class="theme-image-editor-actions">
        <Button variant="secondary" size="sm" :disabled="!canCancel" @click="emit('cancel')"
          >取消</Button
        >
        <Button size="sm" :disabled="importing || !image || !canApply" @click="apply">应用</Button>
      </div>
    </footer>
  </section>
</template>

<style>
.theme-image-editor {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  gap: 16px;
}
.theme-image-editor-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  gap: 12px;
}
.theme-image-editor-workspace {
  flex: 1 1 0;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 200px;
  gap: 24px;
}
.theme-image-editor-canvas {
  display: flex;
  flex-direction: row;
  gap: 16px;
  min-width: 0;
  min-height: 0;
}
.theme-image-editor-canvas.has-image {
  padding: 12px;
  border-radius: var(--radius-media);
  background: var(--control-muted-bg);
}
.theme-image-editor-footer {
  display: flex;
  flex-shrink: 0;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0 0;
  border-top: 1px solid var(--border-subtle);
}
.theme-image-editor-reset {
  margin-right: auto;
}
.theme-image-editor-settings {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  gap: 20px;
  padding: 4px 0 24px;
  font-size: 13px;
}
.theme-image-editor-settings > * {
  flex-shrink: 0;
}
.theme-image-editor-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.theme-image-editor-image-actions {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  gap: 10px;
  padding-top: 16px;
}
.theme-image-editor-color,
.theme-image-editor-range {
  display: grid;
  gap: 4px;
}
.theme-image-editor-range label {
  display: flex;
  justify-content: space-between;
}
.theme-image-editor-range output {
  color: var(--text-secondary);
  font-size: 12px;
}
.theme-image-editor-color button {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  width: fit-content;
  cursor: pointer;
}
.theme-image-editor-color i {
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-detail);
}
.theme-image-editor-actions {
  display: flex;
  gap: 10px;
}
.theme-image-editor-actions button {
  min-width: 76px;
}
.theme-image-editor-error {
  margin: 0;
  flex-shrink: 0;
  color: var(--state-error);
  font-size: 12px;
}
.theme-image-editor-loading {
  flex: 1;
  display: grid;
  place-items: center;
}
.theme-image-editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  border-radius: var(--radius-media);
  background: var(--control-muted-bg);
  padding: 24px;
}
.theme-image-editor-empty h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.theme-image-editor-empty p {
  margin: 0;
  color: var(--text-secondary);
  font-size: 12px;
}
.theme-image-editor-color button:disabled {
  opacity: 0.5;
  cursor: default;
}
@media (max-width: 760px) {
  .theme-image-editor-workspace {
    grid-template-columns: minmax(0, 1fr) 180px;
    gap: 16px;
  }
}
@media (max-width: 600px) {
  .theme-image-editor-workspace {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .theme-image-editor-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 12px;
    padding: 0;
  }
  .theme-image-editor-hint {
    display: none;
  }
}
</style>
