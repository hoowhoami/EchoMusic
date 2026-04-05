<script setup lang="ts">
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui';

interface Props {
  content?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  contentClass?: string;
}

const props = withDefaults(defineProps<Props>(), {
  content: '',
  side: 'top',
  align: 'center',
  sideOffset: 8,
  delayDuration: 180,
  disabled: false,
  contentClass: '',
});
</script>

<template>
  <slot name="fallback" v-if="props.disabled" />
  <TooltipProvider v-else :delay-duration="props.delayDuration">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot name="trigger" />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="props.side"
          :align="props.align"
          :side-offset="props.sideOffset"
          :class="['app-tooltip-content', props.contentClass]"
        >
          <slot>
            {{ props.content }}
          </slot>
          <TooltipArrow :width="14" :height="8" class="app-tooltip-arrow" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>

<style scoped>
@reference "@/style.css";

:global(.app-tooltip-content) {
  background-clip: padding-box;
  max-width: 260px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-card);
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.45;
  box-shadow: 0 14px 28px rgba(0, 0, 0, 0.12);
  z-index: 300;
  user-select: none;
}

:global(.app-tooltip-arrow) {
  display: block;
  fill: var(--color-bg-card);
  stroke: none;
}
</style>
