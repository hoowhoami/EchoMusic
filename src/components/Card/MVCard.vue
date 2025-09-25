<template>
  <div class="mv-card flex items-center space-x-2">
    <div
      class="mv-cover-wrapper w-[50px] h-[50px] rounded-lg overflow-hidden border cursor-pointer"
    >
      <NImage
        class="mv-cover w-full h-full object-cover"
        :src="cover"
        :preview-disabled="true"
        :alt="props.mv.mv_name"
      >
        <template #placeholder>
          <div class="w-full h-full flex items-center justify-center">
            <NIcon :size="24">
              <MusicNoteFilled />
            </NIcon>
          </div>
        </template>
      </NImage>
    </div>
    <div class="info flex flex-col justify-center">
      <div class="name">
        <TextContainer
          :key="props.mv.mv_name"
          :text="props.mv.mv_name"
          :speed="0.2"
          class="name"
        />
      </div>
      <div class="author flex items-center space-x-1">
        <div class="avatar">
          <NAvatar
            round
            bordered
            :size="22"
            :src="avatar"
          />
        </div>
        <div class="name">
          <NText :depth="3"> {{ props.mv.user_name }} {{ publishDate }} 发布 </NText>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { MV } from '@/types';
import { getCover } from '@/utils';
import { MusicNoteFilled } from '@vicons/material';
import { NAvatar, NImage, NText } from 'naive-ui';
import { computed } from 'vue';
import TextContainer from '../Core/TextContainer.vue';

defineOptions({
  name: 'MVCard',
});

const props = defineProps<{
  mv: MV;
}>();

const cover = computed(() => {
  return getCover(props.mv?.thumb);
});

const avatar = computed(() => {
  return getCover(props.mv?.user_avatar);
});

const publishDate = computed(() => {
  return props.mv?.publish_time?.split(' ')[0] || '-';
});
</script>
<style lang="scss" scoped>
.mv-card {
  .mv-cover {
    width: 50px;
    height: 50px;
  }
  .info {
    .name {
      font-size: 12px;
    }
    .author {
      .avatar {
      }

      .name {
        font-size: 11px;
      }
    }
  }
}
</style>
