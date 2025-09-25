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
          v-if="videoUrl"
          :width="400"
          :height="height - 25"
          :src="videoUrl"
          :volume="0.4"
          autoplay
          controls
          @play="playing = true"
          @pause="playing = false"
          @ended="playing = false"
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
import player from '@/utils/player';
import { VideoPlayer } from '@videojs-player/vue';
import 'video.js/dist/video-js.css';

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

// QHD（2K） > FHD（1080P） > HD（720P） > SD（标清） > LD（低清）
const getQualityVideoUrl = async (detail: any) => {
  try {
    const hashList = [];
    if (detail?.qhd_hash) {
      hashList.push(detail?.qhd_hash);
    }
    if (detail?.fhd_hash) {
      hashList.push(detail?.fhd_hash);
    }
    if (detail?.hd_hash) {
      hashList.push(detail?.hd_hash);
    }
    if (detail?.sd_hash) {
      hashList.push(detail?.sd_hash);
    }
    if (detail?.ld_hash) {
      hashList.push(detail?.ld_hash);
    }
    for (const hash of hashList) {
      const ret = await getVideoUrl(hash);
      const key = hash?.toLowerCase();
      const url = ret?.data?.[key]?.downurl;
      if (url) {
        return url;
      }
    }
  } catch (error) {
    console.error('获取歌曲MV播放地址失败', error);
  }
  return null;
};

const getSongMVInfo = async (mv: MV) => {
  try {
    loading.value = true;
    const res = await getSongMVDetail(mv.video_id);
    const detail = res?.[0];
    const url = await getQualityVideoUrl(detail);
    if (url) {
      videoUrl.value = url;
    } else {
      window.$message.error('暂未获取到歌曲MV播放地址');
    }
  } catch (error) {
    console.error('获取歌曲MV详情失败', error);
  } finally {
    loading.value = false;
  }
};

const handlePlay = async (mv: MV) => {
  await getSongMVInfo(mv);
  // 将音频播放器暂停
  player.pause(true);
};

onMounted(async () => {
  await getSongMVList(props.song);
});
</script>
<style lang="scss" scoped>
.mv-list-container {
  .mv-list {
    .list {
      width: 330px;
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
