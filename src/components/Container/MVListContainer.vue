<template>
  <div class="mv-list-container">
    <div
      v-if="list?.length"
      class="mv-list flex space-x-4"
    >
      <div class="list">
        <MVList
          :height="height"
          :list="list"
          :playing="playing"
          @play="handlePlay"
        />
      </div>
      <div class="player">
        <VideoPlayer
          ref="videoPlayer"
          v-if="videoUrl"
          :width="400"
          :height="height - 25"
          :src="videoUrl"
        />
        <div
          v-else
          class="w-[400px]"
          :style="{ height: `${height}px` }"
        >
          <div class="tip flex justify-center items-center h-full">
            <NText :depth="3">请选择MV播放</NText>
          </div>
        </div>
      </div>
    </div>

    <NEmpty v-else />
  </div>
</template>

<script lang="ts" setup>
import type { MV, Song } from '@/types';
import { getSongMV, getSongMVDetail, getVideoUrl } from '@/api';
import { onMounted, ref } from 'vue';
import MVList from '../List/MVList.vue';
import { NEmpty, NText } from 'naive-ui';
import VideoPlayer from '../Core/VideoPlayer.vue';

defineOptions({
  name: 'MVListContainer',
});

const props = defineProps<{
  song: Song;
}>();

const height = 225;

const loading = ref(false);
const list = ref<MV[]>([]);

const playing = ref(false);
const videoUrl = ref('');
const videoPlayer = ref<InstanceType<typeof VideoPlayer>>();

const getSongMVList = async (song: Song) => {
  list.value = [];
  if (!song || (!song.album_audio_id && !song.mixsongid)) {
    return;
  }
  try {
    loading.value = true;
    const res = await getSongMV(song.album_audio_id || song.mixsongid);
    list.value = res?.[0] || [];
  } catch (error) {
    console.log('获取歌曲MV失败', error);
  } finally {
    loading.value = false;
  }
};

const getSongMVInfo = async (mv: MV) => {
  try {
    loading.value = true;
    const res = await getSongMVDetail(mv.video_id);
    console.log(res);
    const hash = res?.[0]?.hd_hash || '';
    if (hash) {
      const ret = await getVideoUrl(hash);
      console.log(ret);
      const key = hash?.toLowerCase();
      const url = ret?.data?.[key]?.downurl;
      if (url) {
        videoUrl.value = url;
        playing.value = true;
      }
    }
  } catch (error) {
    console.error('获取歌曲MV详情失败', error);
  } finally {
    loading.value = false;
  }
};

const handlePlay = async (mv: MV) => {
  videoPlayer.value?.destroyPlayer();
  console.log(mv);
  await getSongMVInfo(mv);
  videoPlayer.value?.initPlayer();
  playing.value = true;
};

onMounted(async () => {
  await getSongMVList(props.song);
});
</script>
<style lang="scss" scoped>
.mv-list-container {
  .mv-list {
    .list {
      flex: 1;
    }
    .player {
      width: 400px;
      .tip {
        font-size: 14px;
      }
    }
  }
}
</style>
