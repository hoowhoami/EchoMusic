<template>
  <div
    class="play-history-panel"
    :class="{ small: props.size === 'small' }"
  >
    <NThing content-indented>
      <template #avatar>
        <NImage
          class="cover"
          :src="cover"
          :preview-disabled="true"
          object-fit="fill"
        >
          <template #placeholder>
            <div class="flex items-center justify-center h-full">
              <NIcon :size="32">
                <MusicNoteFilled />
              </NIcon>
            </div>
          </template>
        </NImage>
      </template>
      <template #header>
        <NEllipsis :line-clamp="1">
          <div class="name">用户云盘</div>
        </NEllipsis>
      </template>
      <template
        #description
        v-if="props.size !== 'small'"
      >
        <div
          class="flex items-center space-x-2 description-content"
          style="margin-top: -5px"
        >
          <div class="creator flex items-center space-x-2">
            <NAvatar
              round
              size="small"
              :src="avatar"
              :fallback-src="avatar"
            />
            <div
              class="name"
              style="font-size: 12px"
            >
              {{ creator }}
            </div>
            <div
              class="time"
              style="font-size: 12px"
            >
              的云盘
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col justify-between space-y-2">
        <div class="count flex items-center space-x-2">
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <MusicNoteFilled />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.count || 0 }}
            </NText>
          </div>
        </div>
      </div>
      <template
        #footer
        v-if="props.size !== 'small'"
      >
        <div class="flex flex-col space-y-1">
          <NProgress
            :color="{ stops: ['gray', 'red'] }"
            :percentage="percentage"
          >
            <div style="font-size: 12px">
              <NText :depth="3"> {{ percentage }}% </NText>
            </div>
          </NProgress>
          <div style="font-size: 12px">
            <NText :depth="3">
              {{ usedSize }} / {{ capacitySize }} [可用 {{ availableSize }}]
            </NText>
          </div>
        </div>
      </template>
    </NThing>
  </div>
</template>

<script lang="ts" setup>
import { formatBytes, getCover } from '@/utils';
import { NEllipsis, NIcon, NImage, NProgress, NText, NThing } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled } from '@vicons/material';
import { useUserStore } from '@/store';

defineOptions({
  name: 'CloudPanel',
});

const props = defineProps<{
  size?: 'small' | undefined;
  count: number;
  capacity: number;
  available: number;
}>();

const userStore = useUserStore();

const cover = computed(() => getCover('', 150));

const avatar = computed(() => getCover(userStore.pic || '', 50));

const creator = computed(() => userStore.nickname || 'unknown');

const percentage = computed(() => {
  return Number((((props.capacity - props.available) / props.capacity) * 100).toFixed(2));
});

const usedSize = computed(() => {
  return formatBytes(props.capacity - props.available);
});

const capacitySize = computed(() => {
  return formatBytes(props.capacity);
});

const availableSize = computed(() => {
  return formatBytes(props.available);
});
</script>

<style lang="scss" scoped>
.play-history-panel {
  .cover {
    flex-shrink: 0;
    width: 150px;
    border-radius: 8px;
    transition: width 0.3s ease-in-out;
  }

  .name {
    font-size: 16px;
    font-weight: 800;
    transition: font-size 0.3s ease-in-out;
  }

  .description-content {
    transition:
      opacity 0.2s ease-in-out,
      transform 0.2s ease-in-out;
  }

  &.small {
    .cover {
      width: 60px;
    }

    .name {
      font-size: 14px !important;
    }

    .description-content {
      opacity: 0;
      transform: translateY(-5px);
    }
  }
}
</style>
