<template>
  <div
    class="singer-panel"
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
            {{ props.singer?.singername }}
          </div>
        </NEllipsis>
      </template>
      <template #description>
        <div
          class="flex flex-col birthday description-content"
          v-if="props.size !== 'small'"
        >
          生日 {{ props.singer?.birthday }}
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
              {{ props.singer?.songcount || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <AlbumRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.albumcount || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <SmartDisplayRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.mvcount || 0 }}
            </NText>
          </div>
        </div>
        <div
          class="count flex items-center space-x-2"
          v-if="props.size !== 'small'"
        >
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <PeopleRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.fanscount || 0 }}
            </NText>
          </div>
          <div class="flex items-center space-x-1">
            <NIcon :size="16">
              <WhatshotRound />
            </NIcon>
            <NText
              depth="3"
              style="font-size: 12px"
            >
              {{ props.singer?.heat || 0 }}
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
import { Singer } from '@/types';
import { getCover } from '@/utils';
import { NEllipsis, NImage, NThing } from 'naive-ui';
import { computed } from 'vue';
import {
  MusicNoteFilled,
  WhatshotRound,
  SmartDisplayRound,
  PeopleRound,
  AlbumRound,
} from '@vicons/material';

defineOptions({
  name: 'SingerPanel',
});

const props = defineProps<{
  size?: 'small' | undefined;
  singer?: Singer;
}>();

const cover = computed(() => {
  return getCover(props.singer?.imgurl || '', 150);
});

const intro = computed(() => {
  return props.singer?.intro || '暂无简介';
});
</script>

<style lang="scss" scoped>
.singer-panel {
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

  .birthday {
    margin-top: -5px;
    font-size: 12px;
  }

  .description-content {
    transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
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
