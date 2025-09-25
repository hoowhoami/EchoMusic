<template>
  <div
    class="video-player"
    :style="videoWrapperStyles"
  >
    <video
      v-if="props.src"
      id="video-player"
      ref="videoRef"
      class="video-js w-full h-full"
    >
      <source :src="props.src" />
    </video>
  </div>
</template>

<script lang="ts" setup>
import { computed, CSSProperties, onMounted, onUnmounted, ref } from 'vue';
import videojs from 'video.js';
import type { VideoJsPlayerOptions } from 'video.js';
import 'video.js/dist/video-js.min.css';

defineOptions({
  name: 'VideoPlayer',
});

// video标签
const videoRef = ref<HTMLElement | null>(null);

const props = withDefaults(
  defineProps<{
    width?: number;
    height?: number;
    src: string;
  }>(),
  {
    width: 200,
    height: 100,
  },
);

const videoWrapperStyles = computed<CSSProperties>(() => {
  return {
    width: props.width || 200 + 'px',
    height: props.height || 100 + 'px',
  };
});

// video实例对象
let videoPlayer: videojs.Player | null = null;

// 初始化video.js
const initVideo = () => {
  // https://gitcode.gitcode.host/docs-cn/video.js-docs-cn/docs/guides/options.html
  const options: VideoJsPlayerOptions = {
    language: 'zh-CN', // 设置语言
    controls: true, // 是否显示控制条
    preload: 'auto', // 预加载
    autoplay: true, // 是否自动播放
    fluid: true, // 自适应宽高
    src: props.src, // 要嵌入的视频源的源 URL
  };
  if (videoRef.value) {
    // 创建 video 实例
    videoPlayer = videojs(videoRef.value, options, onPlayerReady);
  }
};

// video初始化完成的回调函数
const onPlayerReady = () => {};

onMounted(() => {
  initVideo();
});

onUnmounted(() => {
  if (videoPlayer) {
    videoPlayer.dispose();
    videoPlayer = null;
  }
});
</script>
<style lang="scss" scoped></style>
