<template>
  <div
    class="mv-card flex items-center space-x-2 group"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <div
      class="mv-cover-wrapper relative w-[50px] h-[50px] rounded-lg overflow-hidden border cursor-pointer"
      @click="handlePlay"
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

      <!-- 播放状态遮罩层 -->
      <div
        class="cover-overlay absolute inset-0 bg-black transition-all duration-300 flex items-center justify-center"
        :class="{
          'bg-opacity-40': isPlaying || isHovered,
          'bg-opacity-0': !isPlaying && !isHovered,
        }"
      >
        <!-- 播放按钮 -->
        <div
          v-if="!isPlaying"
          class="play-button transform transition-all duration-300 flex items-center justify-center"
          :class="{
            'scale-100 opacity-100': isHovered,
            'scale-75 opacity-0': !isHovered,
          }"
        >
          <NIcon
            :size="25"
            color="#ffffff"
          >
            <PlayArrowRound />
          </NIcon>
        </div>

        <!-- 音波动画（正在播放时） -->
        <div
          v-if="isPlaying"
          class="absolute inset-0 flex items-center justify-center"
        >
          <div class="flex items-center justify-center space-x-1">
            <div
              v-for="i in 3"
              :key="i"
              class="w-1 rounded-full animate-wave"
              :style="{
                height: `${8 + (i % 2) * 4}px`,
                animationDelay: `${i * 0.15}s`,
                backgroundColor: themeVars.primaryColor,
              }"
            />
          </div>
        </div>
      </div>
    </div>
    <div class="info flex flex-col w-full space-y-2">
      <div class="flex items-center mt-[5px]">
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
import { MusicNoteFilled, PlayArrowRound } from '@vicons/material';
import { NAvatar, NImage, NText, NIcon, useThemeVars } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import TextContainer from '../Core/TextContainer.vue';
import { getSongMVDetail } from '@/api';

defineOptions({
  name: 'MVCard',
});

const props = defineProps<{
  mv: MV;
  playing?: boolean;
}>();

const emit = defineEmits<{
  play: [mv: MV];
}>();

const detail = ref<MV>();

const themeVars = useThemeVars();
const isHovered = ref(false);

// 检查是否正在播放
const isPlaying = computed(() => {
  return props.playing;
});

// 处理播放
const handlePlay = () => {
  emit('play', props.mv);
};

const cover = computed(() => {
  return getCover(detail.value?.cover || props.mv?.thumb);
});

const avatar = computed(() => {
  return getCover(props.mv?.user_avatar);
});

const publishDate = computed(() => {
  return props.mv?.publish_time?.split(' ')[0] || '-';
});

onMounted(async () => {
  const res = await getSongMVDetail(props.mv.video_id);
  detail.value = res?.[0];
});
</script>
<style lang="scss" scoped>
.mv-card {
  .mv-cover-wrapper {
    flex-shrink: 0;
    transition: all 0.3s ease;

    &:hover {
      transform: scale(1.05);
    }
  }

  .mv-cover {
    width: 50px;
    height: 50px;
    transition: transform 0.3s ease;
  }

  .cover-overlay {
    backdrop-filter: blur(0px);
    transition: backdrop-filter 0.3s ease;

    &.bg-opacity-40 {
      backdrop-filter: blur(2px);
    }

    .play-button {
      filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
    }
  }

  .info {
    .name {
      font-size: 12px;
      width: max-content;
      max-width: calc(100% - 100px);
      transition: color 0.3s;
    }

    .author {
      .name {
        font-size: 11px;
      }
    }
  }

  // 音波动画
  @keyframes wave {
    0%,
    100% {
      transform: scaleY(0.3);
      opacity: 0.7;
    }
    50% {
      transform: scaleY(1);
      opacity: 1;
    }
  }

  .animate-wave {
    animation: wave 1.2s ease-in-out infinite;
    transform-origin: bottom;
  }
}
</style>
