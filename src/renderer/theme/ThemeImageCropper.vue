<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, useId, watch } from 'vue';
import { useElementSize } from '@vueuse/core';
import type { ThemeOverride } from './model';
import {
  backgroundCropLayout,
  backgroundCropStage,
  moveBackgroundCrop,
  resizeBackgroundCrop,
  type CropCorner,
  type CropLayout,
  type ImageSize,
} from './imageCrop';

const props = defineProps<{
  image: string;
  background: ThemeOverride['background'];
  viewport: ImageSize;
  shell?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  change: [position: Partial<ThemeOverride['background']>];
  error: [message: string];
}>();
const canvas = ref<HTMLElement>();
const { width, height } = useElementSize(canvas);
const imageSize = ref({ width: 0, height: 0 });
const stageSize = computed(() =>
  backgroundCropStage({ width: width.value, height: height.value }, imageSize.value),
);
const loading = ref(false);
const dragging = ref(false);
const helpId = useId();
const geometry = computed(() =>
  backgroundCropLayout(stageSize.value, props.viewport, imageSize.value, props.background),
);
const rectStyle = (rect: { width: number; height: number; left: number; top: number }) => ({
  width: `${rect.width}px`,
  height: `${rect.height}px`,
  left: `${rect.left}px`,
  top: `${rect.top}px`,
});
const corners = [
  { key: 'nw', label: '左上' },
  { key: 'ne', label: '右上' },
  { key: 'se', label: '右下' },
  { key: 'sw', label: '左下' },
] as const;
let drag: {
  pointerId: number;
  target: HTMLElement;
  x: number;
  y: number;
  corner?: CropCorner;
  layout: CropLayout;
} | null = null;
const stopDrag = () => {
  const previous = drag;
  drag = null;
  dragging.value = false;
  if (previous?.target.hasPointerCapture(previous.pointerId))
    previous.target.releasePointerCapture(previous.pointerId);
};
const updateCrop = (crop: CropLayout['selection']) => {
  if (JSON.stringify(crop) !== JSON.stringify(props.background.crop))
    emit('change', { crop, fit: 'cover', zoom: 100, positionX: 50, positionY: 50 });
};
const startDrag = (event: PointerEvent, corner?: CropCorner) => {
  if (props.disabled || loading.value || !geometry.value || event.button !== 0 || !event.isPrimary)
    return;
  const target = event.currentTarget as HTMLElement;
  target.focus({ preventScroll: true });
  target.setPointerCapture(event.pointerId);
  drag = {
    pointerId: event.pointerId,
    target,
    x: event.clientX,
    y: event.clientY,
    corner,
    layout: geometry.value,
  };
  dragging.value = true;
  event.preventDefault();
};
const moveDrag = (event: PointerEvent) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const x = event.clientX - drag.x,
    y = event.clientY - drag.y;
  updateCrop(
    drag.corner
      ? resizeBackgroundCrop(drag.layout, drag.corner, x, y)
      : moveBackgroundCrop(drag.layout, x, y),
  );
};
const endDrag = (event: PointerEvent) => {
  if (event.pointerId !== drag?.pointerId) return;
  if (event.type === 'pointerup') moveDrag(event);
  stopDrag();
};
const moveWithKeyboard = (event: KeyboardEvent, corner?: CropCorner) => {
  if (props.disabled || loading.value || !geometry.value) return;
  const step = event.shiftKey ? 24 : 6;
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const delta = directions[event.key];
  if (!delta) return;
  event.preventDefault();
  updateCrop(
    corner
      ? resizeBackgroundCrop(geometry.value, corner, ...delta)
      : moveBackgroundCrop(geometry.value, ...delta),
  );
};
watch(
  [
    () => props.image,
    () => props.viewport.width,
    () => props.viewport.height,
    () => props.disabled,
    () => width.value,
    () => height.value,
  ],
  stopDrag,
);
watch(
  () => props.image,
  (url, _, onCleanup) => {
    imageSize.value = { width: 0, height: 0 };
    loading.value = !!url;
    if (!url) return;
    const image = new Image();
    image.onload = () => {
      imageSize.value = { width: image.naturalWidth, height: image.naturalHeight };
      loading.value = false;
    };
    image.onerror = () => {
      loading.value = false;
      emit('error', '背景图片不可用，请重新选择');
    };
    onCleanup(() => {
      image.onload = image.onerror = null;
    });
    image.src = url;
  },
  { immediate: true },
);
const selectWholeImage = () => {
  if (!imageSize.value.width) return;
  updateCrop({
    x: 0,
    y: 0,
    width: imageSize.value.width,
    height: imageSize.value.height,
    sourceWidth: imageSize.value.width,
    sourceHeight: imageSize.value.height,
  });
};
const commitSelection = () => {
  if (props.disabled || loading.value || !geometry.value) return false;
  updateCrop(geometry.value.selection);
  return true;
};
onDeactivated(stopDrag);
onBeforeUnmount(stopDrag);
defineExpose({ selectWholeImage, commitSelection });
</script>

<template>
  <div class="theme-cropper">
    <div ref="canvas" class="theme-crop-canvas">
      <div
        class="theme-crop-stage"
        :style="{ width: `${stageSize.width}px`, height: `${stageSize.height}px` }"
        :aria-busy="loading"
      >
        <template v-if="geometry">
          <img
            class="theme-crop-artwork"
            :src="image"
            :style="rectStyle(geometry.artwork)"
            alt="自定义背景图片"
            :draggable="false"
          />
          <div
            class="theme-crop-shade"
            :style="{
              ...rectStyle(geometry.artwork),
              background: shell,
              opacity: background.shade / 100,
            }"
          />
          <div
            class="theme-crop-window"
            :class="{ 'is-dragging': dragging }"
            :style="rectStyle(geometry.crop)"
            role="group"
            aria-label="背景裁切框"
            :aria-describedby="helpId"
            :aria-disabled="disabled"
            :tabindex="disabled ? -1 : 0"
            @pointerdown="startDrag($event)"
            @pointermove="moveDrag"
            @pointerup="endDrag"
            @pointercancel="endDrag"
            @lostpointercapture="endDrag"
            @keydown="moveWithKeyboard($event)"
          >
            <div class="theme-crop-outline" />
            <button
              v-for="corner in corners"
              :key="corner.key"
              type="button"
              class="theme-crop-handle"
              :class="`is-${corner.key}`"
              :aria-label="`调整裁切框${corner.label}角`"
              :disabled="disabled"
              @pointerdown.stop="startDrag($event, corner.key)"
              @keydown.stop="moveWithKeyboard($event, corner.key)"
            />
          </div>
        </template>
      </div>
      <span v-if="loading" class="theme-crop-loading" role="status">正在加载图片…</span>
    </div>
    <p :id="helpId" class="theme-crop-help">
      拖动裁切框选择区域，拖动四角调整大小
      <span class="sr-only">。也可使用方向键调整，按住 Shift 加快移动。</span>
    </p>
  </div>
</template>

<style scoped>
.theme-cropper {
  min-width: 0;
  min-height: 0;
  width: 100%;
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.theme-crop-canvas {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: grid;
  align-items: center;
  justify-items: start;
  position: relative;
}
.theme-crop-stage {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-media);
  user-select: none;
}
.theme-crop-artwork,
.theme-crop-shade,
.theme-crop-window,
.theme-crop-outline {
  position: absolute;
}
.theme-crop-artwork,
.theme-crop-shade {
  pointer-events: none;
}
.theme-crop-artwork {
  max-width: none;
}
.theme-crop-window {
  cursor: move;
  outline: none;
  touch-action: none;
}
.theme-crop-window.is-dragging {
  cursor: grabbing;
}
.theme-crop-outline {
  inset: 0;
  pointer-events: none;
  border: 2px solid var(--color-primary);
  box-shadow: 0 0 0 2000px rgb(0 0 0 / 48%);
}
.theme-crop-window:focus-visible .theme-crop-outline {
  border-color: var(--text-main);
}
.theme-crop-handle {
  position: absolute;
  z-index: 1;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  outline: none;
  touch-action: none;
}
.theme-crop-handle::after {
  content: '';
  position: absolute;
  inset: 7px;
  background: #fff;
  border: 1px solid var(--color-primary);
  border-radius: 2px;
}
.theme-crop-handle:focus-visible::after {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.theme-crop-handle.is-nw {
  left: -12px;
  top: -12px;
  cursor: nwse-resize;
}
.theme-crop-handle.is-ne {
  right: -12px;
  top: -12px;
  cursor: nesw-resize;
}
.theme-crop-handle.is-se {
  right: -12px;
  bottom: -12px;
  cursor: nwse-resize;
}
.theme-crop-handle.is-sw {
  left: -12px;
  bottom: -12px;
  cursor: nesw-resize;
}
.theme-crop-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 13px;
}
.theme-crop-help {
  flex-shrink: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-secondary);
}
</style>
