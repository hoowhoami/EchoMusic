<template>
  <div class="play-history-panel">
    <NThing content-indented>
      <template #avatar>
        <NImage
          class="cover"
          :src="cover"
          :preview-disabled="true"
          object-fit="fill"
        />
      </template>
      <template #header>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 16px; font-weight: 800"
        >
          最近播放
        </NEllipsis>
      </template>
      <template #description>
        <div
          class="flex items-center space-x-2"
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
              最近正在听...
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col justify-between space-y-2">
        <div
          v-if="tags"
          class="tags flex items-center space-x-2"
        >
          <NTag
            v-for="tag in tags"
            :key="tag"
            size="small"
            round
          >
            {{ tag }}
          </NTag>
        </div>
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
      <template #footer>
        <NEllipsis
          :line-clamp="1"
          style="font-size: 12px"
        >
          人生总是聚少离多，我至今仍然无法习惯。
        </NEllipsis>
      </template>
    </NThing>
  </div>
</template>

<script lang="ts" setup>
import { getCover } from '@/utils';
import { NEllipsis, NIcon, NImage, NThing } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled } from '@vicons/material';
import { useUserStore } from '@/store';

defineOptions({
  name: 'PlayHistoryPanel',
});

const props = defineProps<{
  count: number;
}>();

const userStore = useUserStore();

const cover = computed(() => getCover('', 150));

const avatar = computed(() => getCover(userStore.pic || '', 50));

const creator = computed(() => userStore.nickname || 'unknown');

const tags = computed(() => ['最近播放']);
</script>

<style lang="scss" scoped>
.play-history-panel {
  .cover {
    flex-shrink: 0;
    width: 150px;
    border-radius: 8px;
  }
}
</style>
