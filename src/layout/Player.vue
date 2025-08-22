<template>
  <div class="player">
    <!-- 左侧歌曲信息 -->
    <div class="song-info">
      <img
        v-if="currentSong"
        :src="currentSong.cover"
        :alt="currentSong.title"
        class="song-cover"
      />
      <div v-if="currentSong" class="song-detail">
        <div class="song-title">{{ currentSong.title }}</div>
        <div class="song-artist">{{ currentSong.artist }}</div>
      </div>
      <div v-else class="no-song">暂无播放歌曲</div>
    </div>

    <!-- 中间播放控制 -->
    <div class="player-controls">
      <div class="control-buttons">
        <a-button type="text" size="small" @click="previousSong">
          <step-backward-outlined />
        </a-button>
        <a-button type="primary" shape="circle" size="large" @click="togglePlay">
          <pause-outlined v-if="isPlaying" />
          <caret-right-outlined v-else />
        </a-button>
        <a-button type="text" size="small" @click="nextSong">
          <step-forward-outlined />
        </a-button>
      </div>

      <!-- 进度条 -->
      <div class="progress-container">
        <span class="time current-time">{{ formatTime(currentTime) }}</span>
        <a-slider
          v-model:value="currentTime"
          :max="duration"
          :tooltip-formatter="formatTime"
          @change="seekTo"
          class="progress-slider"
        />
        <span class="time total-time">{{ formatTime(duration) }}</span>
      </div>
    </div>

    <!-- 右侧功能按钮 -->
    <div class="player-actions">
      <a-space size="large">
        <a-tooltip title="歌词">
          <unordered-list-outlined
            :class="['action-icon', { active: showLyrics }]"
            @click="toggleLyrics"
          />
        </a-tooltip>

        <a-tooltip title="播放列表">
          <playlist-outlined
            :class="['action-icon', { active: showPlaylist }]"
            @click="togglePlaylist"
          />
        </a-tooltip>

        <a-tooltip title="循环播放">
          <retweet-outlined
            :class="['action-icon', { active: playMode === 'loop' }]"
            @click="togglePlayMode"
          />
        </a-tooltip>

        <a-tooltip title="随机播放">
          <swap-outlined
            :class="['action-icon', { active: playMode === 'random' }]"
            @click="togglePlayMode"
          />
        </a-tooltip>

        <a-tooltip title="音量">
          <div class="volume-control">
            <sound-outlined
              v-if="volume > 0"
              :class="['action-icon', { active: showVolume }]"
              @click="toggleVolume"
            />
            <mute-outlined v-else class="action-icon" @click="toggleVolume" />
            <a-slider
              v-if="showVolume"
              v-model:value="volume"
              :max="100"
              class="volume-slider"
              @change="changeVolume"
            />
          </div>
        </a-tooltip>
      </a-space>
    </div>

    <!-- 播放列表抽屉 -->
    <a-drawer v-model:open="showPlaylist" title="播放列表" placement="right" width="400">
      <div class="playlist-content">
        <div
          v-for="(song, index) in playlist"
          :key="song.id"
          :class="['playlist-item', { active: currentSong?.id === song.id }]"
          @click="playSong(song)"
        >
          <span class="song-index">{{ index + 1 }}</span>
          <div class="song-info">
            <div class="song-name">{{ song.title }}</div>
            <div class="song-artist-name">{{ song.artist }}</div>
          </div>
          <span class="song-duration">{{ formatTime(song.duration) }}</span>
        </div>
      </div>
    </a-drawer>

    <!-- 歌词抽屉 -->
    <a-drawer v-model:open="showLyrics" title="歌词" placement="right" width="400">
      <div class="lyrics-content">
        <div
          v-for="(line, index) in lyrics"
          :key="index"
          :class="['lyric-line', { active: currentLyricIndex === index }]"
        >
          {{ line }}
        </div>
      </div>
    </a-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  CaretRightOutlined,
  PauseOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
  UnorderedListOutlined,
  PlaylistOutlined,
  RetweetOutlined,
  SwapOutlined,
  SoundOutlined,
  MuteOutlined,
} from '@ant-design/icons-vue';
import { useAppStore } from '@/store';

const appStore = useAppStore();

const currentSong = ref({
  id: 1,
  title: '示例歌曲',
  artist: '示例歌手',
  cover: 'https://via.placeholder.com/50/1890ff/ffffff?text=Song',
  duration: 215,
});

const isPlaying = ref(false);
const currentTime = ref(0);
const duration = ref(215);
const showPlaylist = ref(false);
const showLyrics = ref(false);
const showVolume = ref(false);
const playMode = ref('loop');
const volume = ref(80);
const currentLyricIndex = ref(0);

const playlist = ref([
  {
    id: 1,
    title: '示例歌曲',
    artist: '示例歌手',
    duration: 215,
  },
  {
    id: 2,
    title: '另一首歌',
    artist: '另一个歌手',
    duration: 198,
  },
  {
    id: 3,
    title: '第三首歌',
    artist: '第三个歌手',
    duration: 236,
  },
]);

const lyrics = ref([
  '这是第一句歌词',
  '这是第二句歌词',
  '这是第三句歌词',
  '这是第四句歌词',
  '这是第五句歌词',
]);

const togglePlay = () => {
  isPlaying.value = !isPlaying.value;
  appStore.togglePlay();
};

const previousSong = () => {
  console.log('Previous song');
};

const nextSong = () => {
  console.log('Next song');
};

const seekTo = (value: number) => {
  currentTime.value = value;
  console.log('Seek to:', value);
};

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const toggleLyrics = () => {
  showLyrics.value = !showLyrics.value;
};

const togglePlaylist = () => {
  showPlaylist.value = !showPlaylist.value;
};

const togglePlayMode = () => {
  playMode.value = playMode.value === 'loop' ? 'random' : 'loop';
};

const toggleVolume = () => {
  showVolume.value = !showVolume.value;
};

const changeVolume = (value: number) => {
  volume.value = value;
  appStore.setVolume(value);
};

const playSong = (song: any) => {
  currentSong.value = song;
  currentTime.value = 0;
  isPlaying.value = true;
  appStore.setCurrentTrack(song.title);
  appStore.togglePlay();
};
</script>

<style scoped>
.player {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 24px;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 300px;
}

.song-cover {
  width: 50px;
  height: 50px;
  border-radius: 4px;
}

.song-detail {
  min-width: 0;
}

.song-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.song-artist {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.no-song {
  color: rgba(0, 0, 0, 0.45);
}

.player-controls {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 600px;
  margin: 0 40px;
}

.control-buttons {
  display: flex;
  align-items: center;
  gap: 16px;
}

.progress-container {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

.time {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
  min-width: 45px;
  text-align: center;
}

.progress-slider {
  flex: 1;
}

.player-actions {
  display: flex;
  align-items: center;
}

.action-icon {
  font-size: 18px;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.45);
  transition: color 0.3s;
}

.action-icon:hover,
.action-icon.active {
  color: #1890ff;
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

.volume-slider {
  width: 100px;
}

.playlist-content {
  padding: 16px 0;
}

.playlist-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  cursor: pointer;
  transition: background-color 0.3s;
}

.playlist-item:hover {
  background-color: #f5f5f5;
}

.playlist-item.active {
  background-color: #e6f7ff;
  color: #1890ff;
}

.song-index {
  width: 30px;
  text-align: center;
  color: rgba(0, 0, 0, 0.45);
}

.song-info {
  flex: 1;
  margin: 0 16px;
}

.song-name {
  font-weight: 500;
}

.song-artist-name {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.song-duration {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.lyrics-content {
  padding: 32px 16px;
  text-align: center;
}

.lyric-line {
  padding: 16px 0;
  color: rgba(0, 0, 0, 0.45);
  transition: all 0.3s;
}

.lyric-line.active {
  color: #1890ff;
  font-size: 18px;
  font-weight: 500;
}
</style>
