<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import Tooltip from '@/components/ui/Tooltip.vue';
import { iconLoader2, iconLock } from '@/icons';
import type { OutputTargetView } from '@/stores/output';

const props = defineProps<{ target: OutputTargetView; connecting?: boolean }>();
const name = computed(
  () =>
    props.target.displayName || (props.target.protocol === 'dlna' ? 'DLNA 设备' : 'AirPlay 设备'),
);
const model = computed(() =>
  [...new Set([props.target.manufacturer, props.target.modelName].filter(Boolean))].join(' · '),
);
const address = computed(() => {
  if (props.target.location) {
    try {
      return new URL(props.target.location).hostname;
    } catch {
      // Discovery metadata may contain an invalid description URL.
    }
  }
  const addresses = props.target.addresses ?? [];
  return addresses.find((value) => !value.includes(':')) || addresses[0] || '';
});
const details = computed(
  () => props.target.note || [model.value, address.value].filter(Boolean).join(' · '),
);
</script>

<template>
  <span class="cast-device-info">
    <Tooltip :content="name" overflow-only>
      <template #trigger>
        <span class="cast-device-name">{{ name }}</span>
      </template>
    </Tooltip>
    <span v-if="connecting" class="cast-device-state" role="status">
      <Icon :icon="iconLoader2" width="12" height="12" class="animate-spin" />
      连接中
    </span>
    <Tooltip v-else-if="target.paired === false" content="连接前需输入设备密码或验证码">
      <template #trigger>
        <span class="cast-device-state is-pairing ui-badge badge-muted">
          <Icon :icon="iconLock" width="11" height="11" aria-hidden="true" />
          <span>需验证</span>
        </span>
      </template>
    </Tooltip>
    <Tooltip v-if="details" :content="details">
      <template #trigger>
        <span class="cast-device-meta" :class="{ 'has-model': model && address }">
          <span v-if="model || (!address && target.note)" class="cast-device-model">
            {{ model || target.note }}
          </span>
          <span v-if="model && address" class="cast-device-separator" aria-hidden="true">·</span>
          <span v-if="address" class="cast-device-address">{{ address }}</span>
        </span>
      </template>
    </Tooltip>
  </span>
</template>

<style scoped>
.cast-device-info {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  min-width: 0;
  width: 100%;
  gap: 3px 8px;
}
.cast-device-name {
  grid-column: 1;
  grid-row: 1;
  display: block;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 650;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cast-device-state {
  grid-column: 2;
  grid-row: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--color-primary-text);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.cast-device-meta {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 5px;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
}
.cast-device-state.is-pairing {
  --badge-border: var(--border-subtle);
  color: var(--color-text-secondary);
  gap: 3px;
  font-size: 10px;
  line-height: 1;
}
.cast-device-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cast-device-address {
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cast-device-meta.has-model .cast-device-address {
  max-width: calc(100% - 16px);
}
.cast-device-separator {
  flex: 0 0 auto;
}
</style>
