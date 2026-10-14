<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  autoUpdate,
  computePosition,
  flip,
  hide,
  offset,
  shift,
  size,
  type Placement,
} from '@floating-ui/dom';
import type { TooltipEntry } from '../tooltipRuntime';

const props = defineProps<{ entry: TooltipEntry; tooltipId: string }>();
const emit = defineEmits<{ dismiss: [] }>();
const floating = ref<HTMLElement>();
let cleanup: (() => void) | undefined;
let disposed = false;
let revision = 0;
const Content = () => props.entry.options.renderContent?.() ?? props.entry.options.content;
onMounted(() => {
  const surface = floating.value!;
  const options = props.entry.options;
  const placement =
    `${options.side ?? 'top'}${options.align && options.align !== 'center' ? `-${options.align}` : ''}` as Placement;
  cleanup = autoUpdate(props.entry.element, surface, async () => {
    const current = ++revision;
    const result = await computePosition(props.entry.element, surface, {
      placement,
      strategy: 'fixed',
      middleware: [
        offset(options.sideOffset ?? 8),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply: ({ availableHeight }) => {
            surface.style.setProperty(
              '--tooltip-available-height',
              `${Math.max(0, availableHeight)}px`,
            );
          },
        }),
        hide(),
      ],
    });
    if (disposed || current !== revision) return;
    if (result.middlewareData.hide?.referenceHidden) return emit('dismiss');
    const side = result.placement.split('-')[0];
    Object.assign(surface.style, {
      left: `${result.x}px`,
      top: `${result.y}px`,
      visibility: 'visible',
    });
    surface.dataset.side = side;
  });
});
onBeforeUnmount(() => {
  disposed = true;
  cleanup?.();
});
</script>

<template>
  <div
    :id="tooltipId"
    ref="floating"
    role="tooltip"
    :class="['app-tooltip-surface', 'app-tooltip-content', entry.options.contentClass]"
    data-state="delayed-open"
    style="position: fixed; width: max-content; left: 0; top: 0; visibility: hidden"
  >
    <div class="app-tooltip-body"><Content /></div>
  </div>
</template>

<style>
.app-tooltip-content {
  --tooltip-enter-x: 0px;
  --tooltip-enter-y: 2px;
  max-width: min(300px, calc(100vw - 16px));
  max-height: var(--tooltip-available-height);
  overflow: visible;
  overflow-wrap: anywhere;
  white-space: pre-line;
  z-index: 10030;
  user-select: none;
}
.app-tooltip-body {
  max-height: max(0px, calc(var(--tooltip-available-height, 100vh) - 12px));
  overflow: hidden;
}
.app-tooltip-content[data-side='bottom'] {
  --tooltip-enter-y: -2px;
}
.app-tooltip-content[data-side='left'] {
  --tooltip-enter-x: 2px;
  --tooltip-enter-y: 0px;
}
.app-tooltip-content[data-side='right'] {
  --tooltip-enter-x: -2px;
  --tooltip-enter-y: 0px;
}
@media (prefers-reduced-motion: no-preference) {
  .app-tooltip-content[data-state='delayed-open'] {
    /* Keep opacity at 1 so the optional backdrop blur stays active while entering. */
    animation: tooltip-enter var(--motion-duration-fast) var(--motion-ease-enter);
  }
}
@keyframes tooltip-enter {
  from {
    translate: var(--tooltip-enter-x) var(--tooltip-enter-y);
  }
  to {
    translate: none;
  }
}
</style>
