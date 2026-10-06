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
  coverSize?: number;
}

const props = withDefaults(defineProps<Props>(), {
  coverSize: 360,
});
const router = useRouter();

const handleClick = () => {
  router.push({ name: 'album-detail', params: { id: props.id } });
};
</script>

<template>
  <div class="album-card card-hover group cursor-pointer" @click="handleClick">
    <div class="card-container card-hover-border">
      <div class="cover-wrapper">
        <Cover :url="coverUrl" :size="coverSize" class="w-full h-full" />
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

.card-container {
  @apply p-[10px] rounded-card;
  background: var(--content-panel-bg);
  border: 1px solid var(--content-panel-border);
  box-shadow: var(--shadow-card);
}

.cover-wrapper {
  @apply aspect-square rounded-media overflow-hidden shadow-sm;
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
