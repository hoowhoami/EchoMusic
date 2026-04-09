<script setup lang="ts">
import { useRouter } from 'vue-router';
import Cover from '@/components/ui/Cover.vue';

interface Props {
  id: string | number;
  name: string;
  coverUrl: string;
  artist?: string;
  publishTime?: string;
  subtitle?: string;
}

const props = defineProps<Props>();
const router = useRouter();

const handleClick = () => {
  router.push({ name: 'album-detail', params: { id: props.id } });
};
</script>

<template>
  <div class="album-card group cursor-pointer" @click="handleClick">
    <div class="card-container">
      <div class="cover-wrapper">
        <Cover :url="coverUrl" :size="400" class="w-full h-full" />
      </div>
      <div class="info-wrapper">
        <h3 class="title">{{ name }}</h3>
        <p class="subtitle">
          {{
            subtitle ||
            `${artist || ''}${artist && publishTime ? ' • ' : ''}${publishTime || ''}`.trim()
          }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
@reference "@/style.css";

.album-card {
  @apply transition-all duration-300 ease-out;
}

.album-card:hover {
  transform: scale(1.03);
}

.card-container {
  @apply p-[10px] rounded-[20px] bg-bg-card border border-border-light/50 transition-all duration-300;
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
}

.dark .card-container {
  border-color: color-mix(in srgb, var(--color-border-light) 92%, transparent);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.34);
}

.album-card:hover .card-container {
  box-shadow:
    0 12px 28px rgba(15, 23, 42, 0.12),
    0 0 24px var(--color-primary-light);
}

.dark .album-card:hover .card-container {
  box-shadow:
    0 14px 34px rgba(0, 0, 0, 0.42),
    0 0 24px color-mix(in srgb, var(--color-primary) 18%, transparent);
}

.cover-wrapper {
  @apply aspect-square rounded-[14px] overflow-hidden shadow-sm;
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
</style>
