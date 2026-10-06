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
  coverSize?: number;
  coverRadius?: number;
  showShadow?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  layout: 'grid',
  coverSize: 360,
  showShadow: true,
});

const router = useRouter();

const resolvedCoverRadius = computed(() => {
  return props.coverRadius === undefined ? 'var(--radius-media, 6px)' : `${props.coverRadius}px`;
});

const cardShadow = computed(() => (props.showShadow ? 'var(--playlist-card-shadow)' : 'none'));

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
    class="playlist-card-grid card-hover group cursor-pointer"
    @click="handleClick"
  >
    <div
      class="card-container card-hover-border"
      :style="{
        boxShadow: cardShadow,
      }"
    >
      <div
        class="cover-wrapper"
        :class="coverShadowClass"
        :style="{ borderRadius: resolvedCoverRadius }"
      >
        <Cover
          :url="coverUrl"
          :size="coverSize"
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
.card-container {
  @apply p-[10px] rounded-card;
  --playlist-card-shadow: var(--shadow-card);
  background: var(--content-panel-bg);
  border: 1px solid var(--content-panel-border);
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
  @apply text-[11px] font-semibold text-text-secondary line-clamp-1;
  margin-top: 2px;
}

/* List Layout */
.playlist-card-list {
  @apply flex items-center rounded-card border border-transparent transition-all duration-200;
  padding: 4px 12px;
}

.playlist-card-list:hover {
  background-color: var(--row-hover-bg);
  border-color: var(--border-subtle);
}

.playlist-card-list .title {
  @apply text-[14px] font-semibold text-text-main line-clamp-1;
}

.playlist-card-list .subtitle {
  @apply text-[12px] mt-1;
}
</style>
