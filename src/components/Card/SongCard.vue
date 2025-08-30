<template>
  <div class="song-card flex items-center space-x-2 cursor-pointer" @dblclick.stop>
    <NImage
      v-if="showCover || true"
      class="border rounded-lg"
      :width="coverSize || 40"
      :src="cover"
      :preview-disabled="true"
      :alt="song.name"
    />
    <div class="song-info flex flex-col space-y-1">
      <NEllipsis :line-clamp="1">
        <div class="song-name">
          {{ name }}
        </div>
      </NEllipsis>
      <NEllipsis class=" text-gray-400" :line-clamp="1">
        <div class="song-singer">
          {{ singer }}
        </div>
      </NEllipsis>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Song } from '@/types';
import { getCover } from '@/utils';
import { NEllipsis, NImage } from 'naive-ui';
import { computed } from 'vue';


defineOptions({
  name: 'SongCard',
});

const props = defineProps<{
  song: Song,
  showCover?: boolean,
  coverSize?: number,
}>();

const cover = computed(() => {
    return getCover(props.song.cover);
});

const name = computed(() => {
    const nameParts = props.song.name.split(' - ');                    
    return nameParts.length > 1 ? nameParts[1] : props.song.name;
});

const singer = computed(() => {
    return props.song.singerinfo?.map(item => item.name).join(' / ');
});

</script>

<style scoped lang="scss">
.song-card {
    .song-info {
        .song-name {
            font-size: 12px;
        }
        .song-singer {
            font-size: 10px;
        }
    }
}
</style>