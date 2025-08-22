<template>
  <div class="main-content">
    <!-- Banner -->
    <div class="banner">
      <a-carousel autoplay>
        <div v-for="banner in banners" :key="banner.id" class="banner-item">
          <img :src="banner.image" :alt="banner.title" />
          <div class="banner-content">
            <h3>{{ banner.title }}</h3>
            <p>{{ banner.description }}</p>
          </div>
        </div>
      </a-carousel>
    </div>

    <!-- 推荐歌单 -->
    <div class="section">
      <div class="section-header">
        <h2>推荐歌单</h2>
        <a-button type="link" size="small">更多</a-button>
      </div>
      <a-row :gutter="[16, 16]">
        <a-col
          v-for="playlist in recommendedPlaylists"
          :key="playlist.id"
          :xs="12"
          :sm="8"
          :md="6"
          :lg="4"
          :xl="3"
        >
          <div class="playlist-card" @click="selectPlaylist(playlist)">
            <div class="playlist-cover">
              <img :src="playlist.cover" :alt="playlist.name" />
              <div class="play-count">
                <play-circle-outlined />
                {{ formatCount(playlist.playCount) }}
              </div>
            </div>
            <div class="playlist-name">{{ playlist.name }}</div>
          </div>
        </a-col>
      </a-row>
    </div>

    <!-- 新歌首发 -->
    <div class="section">
      <div class="section-header">
        <h2>新歌首发</h2>
        <a-tabs v-model:activeKey="newSongTab" size="small">
          <a-tab-pane key="all" tab="全部" />
          <a-tab-pane key="chinese" tab="华语" />
          <a-tab-pane key="western" tab="欧美" />
          <a-tab-pane key="japanese" tab="日本" />
          <a-tab-pane key="korean" tab="韩国" />
        </a-tabs>
      </div>
      <a-table :columns="songColumns" :data-source="newSongs" :pagination="false" size="small">
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'title'">
            <div class="song-info">
              <img :src="record.cover" :alt="record.title" class="song-cover" />
              <div class="song-detail">
                <div class="song-title">{{ record.title }}</div>
                <div class="song-artist">{{ record.artist }}</div>
              </div>
            </div>
          </template>
          <template v-else-if="column.key === 'duration'">
            {{ formatDuration(record.duration) }}
          </template>
          <template v-else-if="column.key === 'action'">
            <a-space>
              <play-circle-outlined class="action-icon" @click="playSong(record)" />
              <plus-outlined class="action-icon" />
              <heart-outlined class="action-icon" />
            </a-space>
          </template>
        </template>
      </a-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { PlayCircleOutlined, PlusOutlined, HeartOutlined } from '@ant-design/icons-vue';

const banners = ref([
  {
    id: 1,
    image: 'https://via.placeholder.com/1200x400/1890ff/ffffff?text=Banner+1',
    title: '新歌推荐',
    description: '每日更新最新好歌',
  },
  {
    id: 2,
    image: 'https://via.placeholder.com/1200x400/52c41a/ffffff?text=Banner+2',
    title: '独家放送',
    description: '独家音乐内容',
  },
  {
    id: 3,
    image: 'https://via.placeholder.com/1200x400/fa8c16/ffffff?text=Banner+3',
    title: '歌手专栏',
    description: '了解你的偶像',
  },
]);

const recommendedPlaylists = ref([
  {
    id: 1,
    name: '华语速爆新歌',
    cover: 'https://via.placeholder.com/200/ff4d4f/ffffff?text=1',
    playCount: 1234567,
  },
  {
    id: 2,
    name: '欧美经典',
    cover: 'https://via.placeholder.com/200/1890ff/ffffff?text=2',
    playCount: 987654,
  },
  {
    id: 3,
    name: '轻音乐',
    cover: 'https://via.placeholder.com/200/52c41a/ffffff?text=3',
    playCount: 456789,
  },
  {
    id: 4,
    name: '学习工作',
    cover: 'https://via.placeholder.com/200/fa8c16/ffffff?text=4',
    playCount: 234567,
  },
  {
    id: 5,
    name: '运动健身',
    cover: 'https://via.placeholder.com/200/722ed1/ffffff?text=5',
    playCount: 345678,
  },
  {
    id: 6,
    name: '放松心情',
    cover: 'https://via.placeholder.com/200/eb2f96/ffffff?text=6',
    playCount: 567890,
  },
  {
    id: 7,
    name: '怀旧金曲',
    cover: 'https://via.placeholder.com/200/13c2c2/ffffff?text=7',
    playCount: 789012,
  },
  {
    id: 8,
    name: '睡前音乐',
    cover: 'https://via.placeholder.com/200/52c41a/ffffff?text=8',
    playCount: 345678,
  },
]);

const newSongTab = ref('all');
const songColumns = [
  {
    title: '',
    key: 'index',
    width: 50,
    customRender: ({ index }: { index: number }) => index + 1,
  },
  {
    title: '歌曲',
    key: 'title',
  },
  {
    title: '歌手',
    dataIndex: 'artist',
    key: 'artist',
  },
  {
    title: '专辑',
    dataIndex: 'album',
    key: 'album',
  },
  {
    title: '时长',
    key: 'duration',
    width: 80,
  },
  {
    title: '操作',
    key: 'action',
    width: 120,
  },
];

const newSongs = ref([
  {
    id: 1,
    title: '新歌速递',
    artist: '歌手A',
    album: '专辑A',
    duration: 215,
    cover: 'https://via.placeholder.com/50/1890ff/ffffff?text=S1',
  },
  {
    id: 2,
    title: '夏日清风',
    artist: '歌手B',
    album: '专辑B',
    duration: 198,
    cover: 'https://via.placeholder.com/50/52c41a/ffffff?text=S2',
  },
  {
    id: 3,
    title: '梦想起航',
    artist: '歌手C',
    album: '专辑C',
    duration: 236,
    cover: 'https://via.placeholder.com/50/fa8c16/ffffff?text=S3',
  },
  {
    id: 4,
    title: '夜空中最亮的星',
    artist: '歌手D',
    album: '专辑D',
    duration: 245,
    cover: 'https://via.placeholder.com/50/722ed1/ffffff?text=S4',
  },
]);

const formatCount = (count: number) => {
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + '万';
  }
  return count.toString();
};

const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const selectPlaylist = (playlist: any) => {
  console.log('Select playlist:', playlist);
};

const playSong = (song: any) => {
  console.log('Play song:', song);
};
</script>

<style scoped>
.main-content {
  padding: 24px;
}

.banner {
  margin-bottom: 32px;
  border-radius: 8px;
  overflow: hidden;
}

.banner-item {
  position: relative;
  height: 400px;
}

.banner-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.banner-content {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 40px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.8), transparent);
  color: white;
}

.banner-content h3 {
  font-size: 32px;
  margin-bottom: 8px;
}

.section {
  margin-bottom: 48px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.section-header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
}

.playlist-card {
  cursor: pointer;
  transition: transform 0.3s;
}

.playlist-card:hover {
  transform: translateY(-4px);
}

.playlist-cover {
  position: relative;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 8px;
}

.playlist-cover img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
}

.play-count {
  position: absolute;
  top: 4px;
  right: 4px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.playlist-name {
  font-size: 14px;
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.song-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.song-cover {
  width: 50px;
  height: 50px;
  border-radius: 4px;
}

.song-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.song-title {
  font-weight: 500;
}

.song-artist {
  font-size: 12px;
  color: rgba(0, 0, 0, 0.45);
}

.action-icon {
  font-size: 16px;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.45);
  transition: color 0.3s;
}

.action-icon:hover {
  color: #1890ff;
}
</style>
