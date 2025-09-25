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

const emit = defineEmits<{
  ended: [];
  play: [];
  pause: [];
  ready: [player: videojs.Player];
  loaded: [];
  error: [error: any];
}>();

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
const onPlayerReady = (player: videojs.Player) => {
  emit('ready', player);
};

const setupEventListeners = () => {
  if (!videoPlayer) {
    return;
  }

  // 1. 播放完成事件（最常用）
  videoPlayer.on('ended', () => {
    emit('ended');
  });

  // 2. 开始播放事件
  videoPlayer.on('play', () => {
    emit('play');
  });

  // 3. 暂停事件
  videoPlayer.on('pause', () => {
    emit('pause');
  });

  // 4. 视频加载完成事件（可播放）
  videoPlayer.on('loadedmetadata', () => {
    emit('loaded');
  });

  // 5. 播放出错事件
  videoPlayer.on('error', () => {
    emit('error', videoPlayer.error());
  });
};

// 初始化播放器
const initPlayer = () => {
  initVideo();
  setupEventListeners();
};

// 加载视频
const load = (src: string) => {
  if (src && videoPlayer) {
    videoPlayer.src(src);
    videoPlayer.load();
  }
};

// 销毁播放器
const destroyPlayer = () => {
  if (videoPlayer) {
    console.log(videoPlayer);
    videoPlayer.dispose();
    videoPlayer = null;
  }
};

onMounted(() => {
  initPlayer();
});

onUnmounted(() => {
  destroyPlayer();
});

defineExpose({
  videoPlayer,
  initPlayer,
  load,
  destroyPlayer,
});
</script>
<style lang="scss" scoped></style>
