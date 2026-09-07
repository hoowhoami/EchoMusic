<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useAttrs,
  watch,
  normalizeStyle,
} from 'vue';
import { usePageStickyLayers } from '@/composables/usePageStickyLayers';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ stickyTop?: number; flowHeight?: number }>();
const attrs = useAttrs();
const context = usePageStickyLayers();
const placeholder = ref<HTMLElement | null>(null);
const layer = ref<HTMLElement | null>(null);
const content = ref<HTMLElement | null>(null);
const target = computed(() => context?.target.value ?? null);
let dispose: (() => void) | undefined;
const bind = async () => {
  await nextTick();
  dispose?.();
  dispose = undefined;
  if (!context || !target.value || !placeholder.value || !layer.value || !content.value) return;
  dispose = context.register({
    placeholder: placeholder.value,
    layer: layer.value,
    content: content.value,
    top: () =>
      props.stickyTop ??
      (parseFloat(
        String((normalizeStyle(attrs.style) as Record<string, unknown> | undefined)?.top ?? 0),
      ) ||
        0),
    flowHeight: () => props.flowHeight,
  });
};
watch(target, bind);
watch(
  () => [props.stickyTop, props.flowHeight, attrs.style],
  () => nextTick(() => context?.update()),
  { deep: true },
);
onMounted(bind);
onBeforeUnmount(() => dispose?.());
</script>

<template>
  <div ref="placeholder" class="page-sticky-placeholder" aria-hidden="true"></div>
  <Teleport :to="target || 'body'" :disabled="!target">
    <div ref="layer" :class="{ 'page-sticky-item': target }">
      <div ref="content" v-bind="attrs"><slot /></div>
    </div>
  </Teleport>
</template>
