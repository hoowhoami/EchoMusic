<template>
  <div
    class="album-panel"
    :class="{ small: props.size === 'small' }"
  >
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
        <NEllipsis :line-clamp="1">
          <div class="name">
            {{ props.album?.albumname }}
          </div>
        </NEllipsis>
      </template>
      <template #description>
        <div
          class="flex flex-col description-content"
          style="margin-top: -5px"
        >
          <div class="creator flex items-center space-x-2">
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
              {{ publishDate }} 发布
            </div>
          </div>
        </div>
      </template>
      <div class="flex flex-col justify-between space-y-2">
        <div
          v-if="tags && props.size !== 'small'"
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
              {{ props.album?.songcount || 0 }}
            </NText>
          </div>
          <div
            class="flex items-center space-x-1"
            v-if="props.size !== 'small'"
          >
            <NIcon :size="16">
              <WhatshotRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.album?.heat || 0 }}
            </NText>
          </div>
        </div>
      </div>
      <template
        #footer
        v-if="props.size !== 'small'"
      >
        <NEllipsis
          :line-clamp="1"
          style="font-size: 12px"
        >
          <template #tooltip>
            <div
              class="intro w-[500px]"
              style="font-size: 11px"
            >
              <p>
                {{ intro }}
              </p>
            </div>
          </template>
          {{ intro }}
        </NEllipsis>
      </template>
    </NThing>
  </div>
</template>

<script lang="ts" setup>
import { Album } from '@/types';
import { getCover } from '@/utils';
import { NEllipsis, NImage, NThing } from 'naive-ui';
import { computed } from 'vue';
import { MusicNoteFilled, WhatshotRound } from '@vicons/material';

defineOptions({
  name: 'AlbumPanel',
});

const props = defineProps<{
  size?: 'small' | undefined;
  album?: Album;
}>();

const cover = computed(() => {
  return getCover(props.album?.img || '', 150);
});

const creator = computed(() => {
  return props.album?.singer || '未知';
});

const publishDate = computed(() => {
  return props.album?.publish_time || '未知';
});

const intro = computed(() => {
  return props.album?.intro || '暂无简介';
});

const tags = computed(() => {
  const list = [];
  const language = props.album?.language;
  if (language) {
    list.push(language);
  }
  const type = props.album?.type;
  if (type) {
    list.push(type);
  }
  return list;
});
</script>

<style lang="scss" scoped>
.album-panel {
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

  .description-content,
  .tags {
    transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
  }

  &.small {
    .cover {
      width: 60px;
    }
    .name {
      font-size: 14px !important;
    }

    .description-content,
    .tags {
      opacity: 0;
      transform: translateY(-5px);
    }
  }
}
</style>
