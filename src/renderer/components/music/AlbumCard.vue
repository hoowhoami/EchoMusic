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
  @apply p-[10px] rounded-[20px] transition-all duration-300;
  background: var(--color-bg-elevated);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-card);
}

.album-card:hover .card-container {
  box-shadow: var(--shadow-card-hover);
  border-color: color-mix(in srgb, var(--color-primary) 28%, var(--border-subtle));
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
