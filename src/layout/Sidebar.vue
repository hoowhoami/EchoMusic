<template>
  <a-menu
    v-model:selectedKeys="selectedKeys"
    v-model:openKeys="openKeys"
    mode="inline"
    theme="dark"
    :inline-collapsed="collapsed"
  >
    <a-menu-item key="discover">
      <template #icon>
        <compass-outlined />
      </template>
      <span>发现音乐</span>
    </a-menu-item>

    <a-menu-item key="fm">
      <template #icon>
        <radio-outlined />
      </template>
      <span>私人FM</span>
    </a-menu-item>

    <a-menu-item key="video">
      <template #icon>
        <video-camera-outlined />
      </template>
      <span>视频</span>
    </a-menu-item>

    <a-menu-item key="friend">
      <template #icon>
        <user-outlined />
      </template>
      <span>朋友</span>
    </a-menu-item>

    <a-sub-menu key="library">
      <template #icon>
        <folder-outlined />
      </template>
      <template #title>我的音乐</template>
      <a-menu-item key="local">本地音乐</a-menu-item>
      <a-menu-item key="download">下载管理</a-menu-item>
      <a-menu-item key="cloud">我的音乐云盘</a-menu-item>
    </a-sub-menu>

    <a-sub-menu key="playlist">
      <template #icon>
        <playlist-outlined />
      </template>
      <template #title>创建的歌单</template>
      <a-menu-item key="favorite">我喜欢的音乐</a-menu-item>
    </a-sub-menu>
  </a-menu>

  <div class="playlist-section">
    <div class="section-header">
      <span>收藏的歌单</span>
      <plus-outlined class="add-icon" />
    </div>
    <div class="playlist-list">
      <div v-for="playlist in playlists" :key="playlist.id" class="playlist-item">
        <span>{{ playlist.name }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  CompassOutlined,
  RadioOutlined,
  VideoCameraOutlined,
  UserOutlined,
  FolderOutlined,
  PlaylistOutlined,
  PlusOutlined,
} from '@ant-design/icons-vue';

defineProps<{
  collapsed: boolean;
}>();

const selectedKeys = ref<string[]>(['discover']);
const openKeys = ref<string[]>(['library', 'playlist']);

const playlists = ref([
  { id: 1, name: '华语经典' },
  { id: 2, name: '欧美流行' },
  { id: 3, name: '轻音乐' },
  { id: 4, name: '学习工作' },
]);
</script>

<style scoped>
.playlist-section {
  padding: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: rgba(255, 255, 255, 0.65);
  font-size: 12px;
  margin-bottom: 8px;
}

.add-icon {
  cursor: pointer;
  transition: color 0.3s;
}

.add-icon:hover {
  color: #fff;
}

.playlist-list {
  max-height: 200px;
  overflow-y: auto;
}

.playlist-item {
  padding: 8px 0;
  color: rgba(255, 255, 255, 0.65);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.playlist-item:hover {
  color: #fff;
}
</style>