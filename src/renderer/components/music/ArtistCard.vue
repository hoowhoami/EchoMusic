<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Cover from '@/components/ui/Cover.vue';

interface Props {
  id: string | number;
  name: string;
  coverUrl: string;
  songCount?: number;
  albumCount?: number;
  fansCount?: number;
  sourceDesc?: string;
  isSinger?: boolean;
  coverSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  isSinger: true,
  coverSize: 360,
});
const router = useRouter();

const formatFans = (count: number): string => {
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
  return String(count);
};

const subtitle = computed(() => {
  const parts: string[] = [];
  if (props.songCount) parts.push(`${props.songCount} 歌曲`);
  if (props.albumCount) parts.push(`${props.albumCount} 专辑`);
  if (parts.length > 0) return parts.join(' • ');
  if (props.fansCount) return `${formatFans(props.fansCount)} 粉丝`;
  if (props.sourceDesc) return props.sourceDesc;
  return '';
});

const handleClick = () => {
  if (props.isSinger) {
    router.push({ name: 'artist-detail', params: { id: props.id } });
  }
};
</script>

<template>
  <div class="artist-card group" :class="{ 'is-singer': isSinger }" @click="handleClick">
    <div class="card-container flex flex-col">
      <div class="cover-shell">
        <div class="cover-wrapper">
          <Cover :url="coverUrl" :size="coverSize" :borderRadius="'50%'" class="w-full h-full" />
        </div>
      </div>
      <div class="info-wrapper w-full">
        <h3 class="title">{{ name }}</h3>
        <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.artist-card {
  @apply transition-all duration-300 ease-out;
}

.artist-card.is-singer {
  @apply cursor-pointer;
}

.artist-card.is-singer:hover {
  transform: scale(1.03);
}

.card-container {
  @apply p-3 rounded-[20px] transition-all duration-300;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
}

.artist-card.is-singer:hover .card-container {
  box-shadow: var(--shadow-card-hover);
  border-color: color-mix(in srgb, var(--color-primary) 28%, var(--border-subtle));
}

.cover-shell {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-wrapper {
  width: min(82%, 180px);
  aspect-ratio: 1;
  border-radius: 999px;
  overflow: hidden;
  box-shadow: var(--shadow-cover);
}

.info-wrapper {
  margin-top: 6px;
  min-height: 38px;
  text-align: left;
}

.title {
  @apply text-[13px] font-semibold text-text-main line-clamp-1;
  line-height: 1.15;
}

.subtitle {
  @apply text-[11px] font-semibold text-text-secondary line-clamp-1 opacity-80;
  margin-top: 3px;
}
</style>
