<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Cover from '@/components/ui/Cover.vue';

interface Props {
  id: string | number;
  name: string;
  coverUrl: string;
  creator?: string;
  songCount?: number;
  layout?: 'grid' | 'list';
  coverRadius?: number;
  showShadow?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  layout: 'grid',
  coverRadius: 14,
  showShadow: true,
});

const router = useRouter();

const resolvedCoverRadius = computed(() => {
  if (props.layout === 'list') return props.coverRadius ?? 10;
  return props.coverRadius ?? 14;
});

const containerRadius = computed(() => {
  if (props.layout === 'grid') {
    return (props.coverRadius ?? 14) + 6;
  }
  return 14;
});

const cardShadow = computed(() => (props.showShadow ? 'var(--playlist-card-shadow)' : 'none'));

const cardHoverShadow = computed(() =>
  props.showShadow ? 'var(--playlist-card-hover-shadow)' : 'none',
);

const coverShadowClass = computed(() => (props.showShadow ? 'shadow-sm' : ''));

const subtitle = computed(() => {
  if (props.creator && props.songCount) {
    return `${props.creator} • ${props.songCount} 首歌曲`;
  }
  return props.creator || (props.songCount ? `${props.songCount} 首歌曲` : '');
});

const handleClick = () => {
  router.push({ name: 'playlist-detail', params: { id: props.id } });
};
</script>

<template>
  <div
    v-if="layout === 'grid'"
    class="playlist-card-grid group cursor-pointer"
    @click="handleClick"
  >
    <div
      class="card-container"
      :style="{
        boxShadow: cardShadow,
        '--playlist-card-hover-shadow': cardHoverShadow,
        borderRadius: `${containerRadius}px`,
      }"
    >
      <div
        class="cover-wrapper"
        :class="coverShadowClass"
        :style="{ borderRadius: `${resolvedCoverRadius}px` }"
      >
        <Cover
          :url="coverUrl"
          :size="400"
          :borderRadius="resolvedCoverRadius"
          class="w-full h-full"
        />
      </div>
      <div class="info-wrapper">
        <h3 class="title">{{ name }}</h3>
        <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
      </div>
    </div>
  </div>

  <div v-else class="playlist-card-list group cursor-pointer" @click="handleClick">
    <Cover
      :url="coverUrl"
      :size="200"
      :width="56"
      :height="56"
      :borderRadius="resolvedCoverRadius"
      class="shrink-0"
    />
    <div class="info-wrapper ml-3 overflow-hidden">
      <h3 class="title">{{ name }}</h3>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

/* Grid Layout */
.playlist-card-grid {
  @apply transition-all duration-300 ease-out;
}

.playlist-card-grid:hover {
  transform: scale(1.03);
}

.card-container {
  @apply p-[10px] rounded-[20px] bg-bg-card border border-border-light/50 transition-all duration-300;
  --playlist-card-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
  --playlist-card-hover-shadow:
    0 12px 28px rgba(15, 23, 42, 0.12), 0 0 24px var(--color-primary-light);
}

.dark .card-container {
  border-color: color-mix(in srgb, var(--color-border-light) 92%, transparent);
  --playlist-card-shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
  --playlist-card-hover-shadow:
    0 14px 34px rgba(0, 0, 0, 0.42),
    0 0 24px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.playlist-card-grid:hover .card-container {
  box-shadow: var(--playlist-card-hover-shadow, 0 10px 24px rgba(0, 0, 0, 0.12));
}

.cover-wrapper {
  @apply aspect-square overflow-hidden;
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
  @apply text-[11px] font-semibold text-text-secondary line-clamp-1 opacity-80;
  margin-top: 2px;
}

/* List Layout */
.playlist-card-list {
  @apply flex items-center rounded-[14px] border border-transparent transition-all duration-200;
  padding: 4px 12px;
}

.playlist-card-list:hover {
  background-color: color-mix(in srgb, var(--color-text-main) 5%, transparent);
  border-color: color-mix(in srgb, var(--color-border-light) 80%, transparent);
}

.playlist-card-list .title {
  @apply text-[14px] font-semibold text-text-main line-clamp-1;
}

.playlist-card-list .subtitle {
  @apply text-[12px] mt-1;
}
</style>
