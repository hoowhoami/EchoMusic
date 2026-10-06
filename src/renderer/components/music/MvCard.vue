<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Cover from '@/components/ui/Cover.vue';
import { iconPlay } from '@/icons';

interface Props {
  videoId: string | number;
  hash: string;
  title: string;
  coverUrl: string;
  artist?: string;
  duration?: number;
  publishDate?: string;
  albumAudioId?: string | number;
  coverSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  coverSize: 360,
});
const router = useRouter();

const formatDuration = (ms?: number) => {
  if (!ms || ms <= 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const durationText = computed(() => formatDuration(props.duration));

const handleClick = () => {
  router.push({
    name: 'mv-detail',
    params: { id: props.hash || props.videoId },
    query: {
      hash: props.hash,
      videoId: String(props.videoId),
      albumAudioId: props.albumAudioId ? String(props.albumAudioId) : '',
      title: props.title,
      artist: props.artist ?? '',
      cover: props.coverUrl,
    },
  });
};
</script>

<template>
  <div class="mv-card card-hover group cursor-pointer" @click="handleClick">
    <div class="card-container card-hover-border">
      <div class="cover-wrapper">
        <Cover :url="coverUrl" :size="coverSize" class="w-full h-full" />
        <!-- 播放图标遮罩 -->
        <div class="play-overlay">
          <div class="play-icon-circle">
            <Icon :icon="iconPlay" width="14" height="14" class="ml-0.5" />
          </div>
        </div>
        <!-- 时长标签 -->
        <span v-if="durationText" class="duration-badge">{{ durationText }}</span>
      </div>
      <div class="info-wrapper">
        <h3 class="title">{{ title }}</h3>
        <p v-if="artist || publishDate" class="subtitle">
          {{ [artist, publishDate].filter(Boolean).join(' • ') }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.card-container {
  @apply p-[8px] rounded-card;
  background: var(--content-panel-bg);
  border: 1px solid var(--content-panel-border);
  box-shadow: var(--shadow-card);
}

.cover-wrapper {
  @apply aspect-video rounded-media overflow-hidden shadow-sm relative;
}

.play-overlay {
  @apply absolute inset-0 flex items-center justify-center bg-black/0;
  transition: background-color var(--motion-duration-normal) var(--motion-ease-standard);
}

.mv-card:hover .play-overlay {
  @apply bg-black/30;
}

.play-icon-circle {
  @apply w-9 h-9 rounded-full bg-white/90 flex items-center justify-center text-black opacity-0 scale-75;
  transition:
    opacity var(--motion-duration-normal) var(--motion-ease-standard),
    transform var(--motion-duration-normal) var(--motion-ease-standard),
    scale var(--motion-duration-normal) var(--motion-ease-standard);
}

.mv-card:hover .play-icon-circle {
  @apply opacity-100 scale-100;
}

.duration-badge {
  position: absolute;
  bottom: 8px;
  right: 8px;
}

.info-wrapper {
  @apply mt-2 px-0.5;
  min-height: 36px;
}

.title {
  @apply text-[13px] font-semibold text-text-main line-clamp-1;
  line-height: 1.1;
}

.subtitle {
  @apply text-[11px] font-semibold text-text-secondary line-clamp-1;
  margin-top: 2px;
}
</style>
