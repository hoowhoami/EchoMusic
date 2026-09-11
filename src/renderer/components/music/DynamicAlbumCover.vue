<script setup lang="ts">
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, shallowRef, watch } from 'vue';
import {
  useDocumentVisibility,
  useElementVisibility,
  usePreferredReducedMotion,
} from '@vueuse/core';
import Cover from '@/components/ui/Cover.vue';
import { loadAlbumDynamicCover } from '@/services/albumDynamicCover';
import { normalizeAlbumCoverId, type AlbumDynamicCover } from '@/utils/albumDynamicCover';

const props = withDefaults(
  defineProps<{
    url?: string;
    albumAudioId?: string | number;
    albumId?: string | number;
    enabled?: boolean;
    active?: boolean;
    size?: number;
    borderRadius?: number;
    alt?: string;
  }>(),
  {
    url: '',
    enabled: false,
    active: true,
    size: 800,
    borderRadius: 12,
    alt: '专辑封面',
  },
);

const root = ref<HTMLElement | null>(null);
const videoRef = ref<HTMLVideoElement | null>(null);
const visible = useElementVisibility(root);
const documentVisibility = useDocumentVisibility();
const reducedMotion = usePreferredReducedMotion();
const deactivated = ref(false);
const cover = shallowRef<AlbumDynamicCover | null>(null);
const sourceIndex = ref(0);
const ready = ref(false);
const audioId = computed(() => normalizeAlbumCoverId(props.albumAudioId));
const albumId = computed(() => normalizeAlbumCoverId(props.albumId));
const resourceKey = computed(() => `${audioId.value}:${albumId.value}`);
const motionEnabled = computed(() => props.enabled && reducedMotion.value !== 'reduce');
const canPlay = computed(
  () =>
    motionEnabled.value &&
    props.active &&
    visible.value &&
    documentVisibility.value === 'visible' &&
    !deactivated.value,
);
const videoUrl = computed(() =>
  motionEnabled.value ? cover.value?.urls[sourceIndex.value] || '' : '',
);
watch(
  videoUrl,
  () => {
    ready.value = false;
  },
  { flush: 'sync' },
);

watch(
  resourceKey,
  () => {
    cover.value = null;
    sourceIndex.value = 0;
    ready.value = false;
  },
  { flush: 'sync' },
);

watch(
  [resourceKey, canPlay],
  async ([key, playing], _previous, onCleanup) => {
    if (!playing || !audioId.value) return;
    let canceled = false;
    onCleanup(() => {
      canceled = true;
    });
    try {
      const next = await loadAlbumDynamicCover(audioId.value, albumId.value);
      if (canceled || key !== resourceKey.value || !canPlay.value) return;
      // Refresh expiring signed URLs when returning to a hidden/cached page, while
      // retaining the current video frame on an ordinary music pause/resume.
      if (JSON.stringify(next?.urls) !== JSON.stringify(cover.value?.urls)) {
        sourceIndex.value = 0;
        ready.value = false;
      }
      cover.value = next;
    } catch {
      // Optional artwork never blocks music or replaces the static cover with an error.
    }
  },
  { immediate: true },
);

const releaseVideo = (video: HTMLVideoElement | null) => {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
};
const nextSource = (video: HTMLVideoElement) => {
  // A decode error can emit both an error event and reject play(). Advance once.
  if (video !== videoRef.value || video.getAttribute('src') !== videoUrl.value) return;
  ready.value = false;
  sourceIndex.value++;
};
const handleError = (event: Event) => nextSource(event.currentTarget as HTMLVideoElement);
const handlePlaying = (event: Event) => {
  const video = event.currentTarget as HTMLVideoElement;
  if (video !== videoRef.value) return;
  if (!canPlay.value) video.pause();
  else ready.value = true;
};

watch(
  [videoRef, canPlay],
  ([video, playing], [previousVideo]) => {
    if (previousVideo !== video) releaseVideo(previousVideo);
    if (!video) return;
    if (!playing) {
      video.pause();
      return;
    }
    video.muted = true;
    void video.play().catch((error: unknown) => {
      if (!canPlay.value || (error instanceof DOMException && error.name === 'AbortError')) return;
      nextSource(video);
    });
  },
  { flush: 'post' },
);

onActivated(() => {
  deactivated.value = false;
});
onDeactivated(() => {
  deactivated.value = true;
});
onBeforeUnmount(() => releaseVideo(videoRef.value));
</script>

<template>
  <div ref="root" class="dynamic-album-cover" :style="{ borderRadius: `${borderRadius}px` }">
    <Cover
      :url="url"
      :size="size"
      :border-radius="borderRadius"
      :alt="alt"
      class="dynamic-cover-poster"
    />
    <video
      v-if="videoUrl"
      :key="videoUrl"
      ref="videoRef"
      :src="videoUrl"
      class="dynamic-cover-video"
      :class="{ 'is-ready': ready }"
      muted
      loop
      playsinline
      disablepictureinpicture
      disableremoteplayback
      preload="none"
      aria-hidden="true"
      @playing="handlePlaying"
      @error="handleError"
    />
  </div>
</template>

<style scoped>
.dynamic-album-cover {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.dynamic-cover-poster {
  width: 100%;
  height: 100%;
}

.dynamic-cover-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.25s ease;
}

.dynamic-cover-video.is-ready {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .dynamic-cover-video {
    transition: none;
  }
}
</style>
