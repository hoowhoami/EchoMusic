<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Popover from '@/components/ui/Popover.vue';
import { iconCast } from '@/icons';
import { useOutputStore } from '@/stores/output';
import CastPanel from './CastPanel.vue';

interface Props {
  variant?: 'bar' | 'lyric';
  showBadge?: boolean;
  open?: boolean;
  side?: 'top' | 'bottom';
  showArrow?: boolean;
  hoverClose?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'bar',
  showBadge: true,
  open: undefined,
  side: 'top',
  showArrow: true,
  hoverClose: false,
});

const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const output = useOutputStore();
const popoverRef = ref<InstanceType<typeof Popover> | null>(null);

const remoteActive = computed(() => output.snapshot && output.snapshot.protocol !== 'local');
const triggerMode = computed(() =>
  props.hoverClose || props.open === undefined ? 'hover' : 'click',
);
const buttonClass = computed(() => {
  if (remoteActive.value) {
    return props.variant === 'lyric' ? 'text-black dark:text-white' : 'text-primary-text';
  }
  return props.variant === 'lyric'
    ? 'text-black/40 dark:text-white/40 hover:text-black dark:hover:text-white'
    : 'text-text-main/50 hover:text-primary-text';
});

function closePopover(): void {
  popoverRef.value?.close();
  emit('update:open', false);
}
</script>

<template>
  <Popover
    ref="popoverRef"
    :trigger="triggerMode"
    :open="props.open"
    :side="props.side"
    align="end"
    :side-offset="8"
    :show-arrow="props.showArrow"
    :hold-open="Boolean(output.connectingTargetId)"
    content-class="cast-popover"
    @update:open="emit('update:open', $event)"
  >
    <template #trigger>
      <Button
        variant="unstyled"
        size="none"
        type="button"
        class="p-2 transition-all hover:scale-110 active:scale-90"
        :class="buttonClass"
        :aria-label="remoteActive ? `正在投放到${output.snapshot?.displayName}` : '投放'"
      >
        <span class="relative inline-flex w-5 h-5 items-center justify-center">
          <Icon :icon="iconCast" width="20" height="20" />
          <Badge
            v-if="remoteActive && props.showBadge"
            count="ON"
            class="absolute top-2px"
            :style="{ right: '-14px' }"
          />
        </span>
      </Button>
    </template>

    <CastPanel @close="closePopover" />
  </Popover>
</template>

<style scoped>
:global(.cast-popover.echo-popover-content) {
  width: auto;
  padding: 9px;
  border-color: var(--border-subtle);
}
</style>
