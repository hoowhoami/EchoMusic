<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';

// Paint the panel and arrow in a single backdrop layer. Independent translucent
// layers otherwise blur/composite the panel and its shadow into the arrow again.
const material = ref<HTMLElement | null>(null);
let surface: HTMLElement | null = null;
let resizeObserver: ResizeObserver | undefined;
let placementObserver: MutationObserver | undefined;
let frame = 0;

const updateGeometry = () => {
  frame = 0;
  if (!surface || !material.value) return;
  const arrow = surface.querySelector<HTMLElement>('.floating-surface-arrow');
  if (!arrow) return;
  const panelRect = surface.getBoundingClientRect();
  const arrowRect = arrow.getBoundingClientRect();
  const width = surface.offsetWidth;
  const height = surface.offsetHeight;
  if (!width || !height || !panelRect.width || !panelRect.height) return;
  const scaleX = panelRect.width / width;
  const scaleY = panelRect.height / height;
  const x = 8;
  const y = 8;
  const radius = Math.min(
    parseFloat(getComputedStyle(surface).borderTopLeftRadius) || 0,
    width / 2,
    height / 2,
  );
  const right = x + width;
  const bottom = y + height;
  const rectangle = (dx: number, dy: number) =>
    `M${x + radius + dx} ${y + dy}H${right - radius + dx}A${radius} ${radius} 0 0 1 ${right + dx} ${y + radius + dy}V${bottom - radius + dy}A${radius} ${radius} 0 0 1 ${right - radius + dx} ${bottom + dy}H${x + radius + dx}A${radius} ${radius} 0 0 1 ${x + dx} ${bottom - radius + dy}V${y + radius + dy}A${radius} ${radius} 0 0 1 ${x + radius + dx} ${y + dy}Z`;
  const arrowX = (arrowRect.x + arrowRect.width / 2 - panelRect.x) / scaleX + x;
  const arrowY = (arrowRect.y + arrowRect.height / 2 - panelRect.y) / scaleY + y;
  const visible = getComputedStyle(arrow.parentElement!).visibility !== 'hidden';
  const side = surface.dataset.side;
  const triangle = (dx: number, dy: number) => {
    if (!visible) return '';
    switch (side) {
      case 'top':
        return `M${arrowX - 7 + dx} ${bottom + dy}H${arrowX + 7 + dx}L${arrowX + dx} ${bottom + 8 + dy}Z`;
      case 'bottom':
        return `M${arrowX + 7 + dx} ${y + dy}H${arrowX - 7 + dx}L${arrowX + dx} ${y - 8 + dy}Z`;
      case 'left':
        return `M${right + dx} ${arrowY + 7 + dy}V${arrowY - 7 + dy}L${right + 8 + dx} ${arrowY + dy}Z`;
      case 'right':
        return `M${x + dx} ${arrowY - 7 + dy}V${arrowY + 7 + dy}L${x - 8 + dx} ${arrowY + dy}Z`;
      default:
        return '';
    }
  };
  const shape = rectangle(0, 0) + triangle(0, 0);
  // The shadow is painted after the backdrop, and masked out of the complete
  // silhouette. It cannot darken the arrow or become part of its blur source.
  const outside = `M0 0H${width + 112}V${height + 112}H0Z` + rectangle(48, 48) + triangle(48, 48);
  const geometry = {
    left: `${-8 - surface.clientLeft}px`,
    top: `${-8 - surface.clientTop}px`,
    width: `${width + 16}px`,
    height: `${height + 16}px`,
    '--floating-surface-shape': `path('${shape}')`,
    '--floating-surface-shadow-mask': `path(evenodd, '${outside}')`,
  };
  // Commit the complete material before making the original background transparent.
  for (const [property, value] of Object.entries(geometry)) {
    material.value.style.setProperty(property, value);
  }
  surface.classList.add('floating-surface-unified');
};
const scheduleUpdate = () => {
  if (!frame) frame = requestAnimationFrame(updateGeometry);
};

onMounted(() => {
  surface = material.value?.parentElement ?? null;
  if (!surface) return;
  const arrow = surface.querySelector<HTMLElement>('.floating-surface-arrow');
  resizeObserver = new ResizeObserver(scheduleUpdate);
  resizeObserver.observe(surface, { box: 'border-box' });
  if (arrow) resizeObserver.observe(arrow);
  placementObserver = new MutationObserver(scheduleUpdate);
  placementObserver.observe(surface, { attributes: true, attributeFilter: ['data-side'] });
  if (arrow?.parentElement)
    placementObserver.observe(arrow.parentElement, {
      attributes: true,
      attributeFilter: ['style'],
    });
  scheduleUpdate();
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  placementObserver?.disconnect();
  if (frame) cancelAnimationFrame(frame);
  surface?.classList.remove('floating-surface-unified');
});
</script>

<template>
  <span ref="material" class="floating-surface-material" aria-hidden="true">
    <span class="floating-surface-fill" />
    <span class="floating-surface-shadow"><span class="floating-surface-shadow-body" /></span>
  </span>
</template>

<style>
:root .floating-surface-unified {
  position: relative;
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  box-shadow: none;
}
.floating-surface-unified .floating-surface-arrow {
  background: transparent;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}
.floating-surface-material {
  position: absolute;
  left: -8px;
  top: -8px;
  z-index: -1;
  pointer-events: none;
}
.floating-surface-fill {
  position: absolute;
  inset: 0;
  background: var(--floating-surface-bg);
  -webkit-backdrop-filter: var(--floating-surface-filter);
  backdrop-filter: var(--floating-surface-filter);
  clip-path: var(--floating-surface-shape);
}
.floating-surface-shadow {
  position: absolute;
  inset: -48px;
  clip-path: var(--floating-surface-shadow-mask);
}
.floating-surface-shadow-body {
  position: absolute;
  inset: 56px;
  border-radius: var(--radius-popover);
  box-shadow: var(--shadow-elevated);
}
/* An ancestor opacity below 1 isolates descendant backdrop filters. Keep the
 * positioning layer opaque and fade the material, shadow and content separately. */
@media (prefers-reduced-motion: no-preference) {
  :root .echo-popover-content.floating-surface-unified[data-state='open'] {
    animation-name: floating-surface-popover-in;
  }
  :root
    .app-tooltip-content.floating-surface-unified:is(
      [data-state='delayed-open'],
      [data-state='instant-open']
    ) {
    animation-name: floating-surface-in;
  }
  :root .floating-surface-unified[data-state='closed'] {
    animation-name: floating-surface-out;
  }
  .floating-surface-unified {
    --floating-surface-enter-duration: var(--motion-duration-normal);
  }
  .app-tooltip-content.floating-surface-unified {
    --floating-surface-enter-duration: var(--motion-duration-fast);
  }
  .floating-surface-unified:is(
      [data-state='open'],
      [data-state='delayed-open'],
      [data-state='instant-open']
    )
    > div:first-child,
  .floating-surface-unified:is(
      [data-state='open'],
      [data-state='delayed-open'],
      [data-state='instant-open']
    )
    .floating-surface-fill,
  .floating-surface-unified:is(
      [data-state='open'],
      [data-state='delayed-open'],
      [data-state='instant-open']
    )
    .floating-surface-shadow {
    animation: motion-fade-in var(--floating-surface-enter-duration) var(--motion-ease-enter);
  }
  .floating-surface-unified[data-state='closed'] > div:first-child,
  .floating-surface-unified[data-state='closed'] .floating-surface-fill,
  .floating-surface-unified[data-state='closed'] .floating-surface-shadow {
    animation: motion-fade-out var(--motion-duration-fast) var(--motion-ease-exit);
  }
}
@keyframes floating-surface-popover-in {
  from {
    translate: var(--motion-popover-x) var(--motion-popover-y);
  }
  to {
    translate: none;
  }
}
/* Distinct enter/exit names preserve Reka's presence lifecycle. */
@keyframes floating-surface-in {
  from {
    translate: none;
  }
  to {
    translate: none;
  }
}
@keyframes floating-surface-out {
  from {
    translate: none;
  }
  to {
    translate: none;
  }
}
</style>
