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
}

const props = withDefaults(defineProps<Props>(), {
  isSinger: true,
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
  <div
    class="artist-card group"
    :class="{ 'is-singer': isSinger }"
    @click="handleClick"
  >
    <div class="card-container flex flex-col">
      <div class="cover-shell">
        <div class="cover-wrapper">
          <Cover :url="coverUrl" :size="400" :borderRadius="'50%'" class="w-full h-full" />
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
  @apply p-3 rounded-[20px] bg-bg-card border border-border-light/50 transition-all duration-300;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
}

.dark .card-container {
  border-color: color-mix(in srgb, var(--color-border-light) 92%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
}

.artist-card.is-singer:hover .card-container {
  box-shadow:
    0 12px 28px rgba(15, 23, 42, 0.12),
    0 0 24px var(--color-primary-light);
}

.dark .artist-card.is-singer:hover .card-container {
  box-shadow:
    0 14px 34px rgba(0, 0, 0, 0.42),
    0 0 24px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.cover-shell {
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cover-wrapper {
  width: 126px;
  height: 126px;
  border-radius: 999px;
  overflow: hidden;
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.12);
}

.dark .cover-wrapper {
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
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
