<template>
  <div class="playlist-detail">
    <!-- 歌单头部信息 -->
    <div class="playlist-header">
      <div class="cover">
        <NImage
          :src="playlist.coverImgUrl"
          :alt="playlist.name"
          :preview-disabled="true"
          object-fit="cover"
          lazy
        />
      </div>
      <div class="info">
        <NH1>{{ playlist.name }}</NH1>
        <div class="creator">
          <NAvatar :src="playlist.creator?.avatarUrl" :size="24" circle />
          <NText depth="3">{{ playlist.creator?.nickname }}</NText>
          <NText depth="3" class="create-time">{{ formatDate(playlist.createTime) }} 创建</NText>
        </div>
        <div class="stats">
          <NText depth="3">
            <NIcon size="16" :component="PlayCircleOutline" />
            {{ formatNumber(playlist.playCount) }} 播放
          </NText>
          <NText depth="3">
            <NIcon size="16" :component="MusicalNoteOutline" />
            {{ playlist.trackCount }} 首
          </NText>
        </div>
        <div class="description" v-if="playlist.description">
          <NText depth="3">{{ playlist.description }}</NText>
        </div>
        <div class="actions">
          <NSpace :size="12">
            <NButton type="primary" @click="playAll">
              <template #icon>
                <NIcon :component="PlayCircleOutline" />
              </template>
              播放全部
            </NButton>
            <NButton @click="toggleBatchMode" :type="batchMode ? 'warning' : 'default'">
              <template #icon>
                <NIcon :component="CheckboxOutline" />
              </template>
              {{ batchMode ? '退出批量操作' : '批量操作' }}
            </NButton>
            <NButton @click="downloadAll">
              <template #icon>
                <NIcon :component="DownloadOutline" />
              </template>
              下载全部
            </NButton>
            <NButton @click="showCreatePlaylist">
              <template #icon>
                <NIcon :component="AddCircleOutline" />
              </template>
              新建歌单
            </NButton>
            <NButton @click="sharePlaylist">
              <template #icon>
                <NIcon :component="ShareOutline" />
              </template>
              分享
            </NButton>
          </NSpace>
        </div>
      </div>
    </div>

    <!-- 歌曲列表 -->
    <div class="songs-section">
      <SongList
        :songs="songs"
        :show-batch-actions="batchMode"
        :show-checkbox="batchMode"
        :max-height="600"
        @play="handlePlay"
        @download="handleDownload"
        @delete="handleDelete"
        @batch-play="handleBatchPlay"
        @batch-add="handleBatchAdd"
        @batch-download="handleBatchDownload"
        @batch-delete="handleBatchDelete"
      />
    </div>

    <!-- 批量操作弹窗 -->
    <BatchOperationsModal
      v-model:show="batchModal.show"
      :action="batchModal.action"
      :songs="batchModal.songs"
      @confirm="handleBatchConfirm"
    />

    <!-- 歌单管理弹窗 -->
    <PlaylistManagement
      v-model:show="playlistManagement.show"
      :mode="playlistManagement.mode"
      :songs="playlistManagement.songs"
      @success="handlePlaylistManagementSuccess"
    />
  </div>
</template>

<script setup lang="ts">
import { NH1, NImage, NAvatar, NText, NIcon, NButton, NSpace } from 'naive-ui';
import {
  PlayCircleOutline,
  MusicalNoteOutline,
  CheckboxOutline,
  DownloadOutline,
  ShareOutline,
  AddCircleOutline,
} from '@vicons/ionicons5';
import { ref, reactive, onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useNaiveDiscreteApi } from '@/hooks';
import SongList, { Song } from '@/components/SongList.vue';
import BatchOperationsModal from '@/components/BatchOperationsModal.vue';
import { getPlaylistDetail, getPlaylistTrackAll, deletePlaylistTrack } from '@/api/playlist';
import PlaylistManagement from './PlaylistManagement.vue';

interface Playlist {
  id: string;
  name: string;
  coverImgUrl: string;
  createTime: number;
  playCount: number;
  trackCount: number;
  description?: string;
  creator?: {
    nickname: string;
    avatarUrl: string;
  };
}

const route = useRoute();
const { message } = useNaiveDiscreteApi();

interface Props {
  playlistId?: string;
}

const props = withDefaults(defineProps<Props>(), {
  playlistId: '',
});

const playlist = reactive<Playlist>({
  id: '',
  name: '',
  coverImgUrl: '',
  createTime: 0,
  playCount: 0,
  trackCount: 0,
});

const songs = ref<Song[]>([]);
const batchMode = ref(false);
const loading = ref(false);

const batchModal = reactive({
  show: false,
  action: 'add' as 'add' | 'download' | 'delete',
  songs: [] as Song[],
});

const playlistManagement = reactive({
  show: false,
  mode: 'create' as 'create' | 'add',
  songs: [] as Song[],
});

const toggleBatchMode = () => {
  batchMode.value = !batchMode.value;
};

const formatDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

const formatNumber = (num: number) => {
  if (num >= 100000000) {
    return `${(num / 100000000).toFixed(1)}亿`;
  }
  if (num >= 10000) {
    return `${(num / 10000).toFixed(1)}万`;
  }
  return num.toString();
};

const fetchPlaylistDetail = async () => {
  // 优先使用传入的 playlistId，其次使用路由参数
  const id = props.playlistId || (route.query.id as string);
  console.log('Playlist ID:', id);
  if (!id) return;

  loading.value = true;
  try {
    // 获取歌单详情
    const playlistResponse = await getPlaylistDetail(id);
    console.log('Playlist response:', playlistResponse);

    // 根据实际API响应结构获取数据
    const playlistData = playlistResponse?.[0] || {};

    // 更新歌单信息
    Object.assign(playlist, {
      id: playlistData.global_collection_id || id,
      name: playlistData.name || '未知歌单',
      coverImgUrl: playlistData.pic || '',
      createTime: playlistData.create_time * 1000 || Date.now(), // 转换为毫秒
      playCount: playlistData.play_count || 0,
      trackCount: playlistData.count || 0,
      description: playlistData.intro || '',
      creator: playlistData.list_create_username
        ? {
            nickname: playlistData.list_create_username,
            avatarUrl: playlistData.create_user_pic || '',
          }
        : undefined,
    });

    // 获取歌单歌曲列表
    await fetchPlaylistTracks(playlistData.global_collection_id || id);
  } catch (error) {
    message.error('获取歌单详情失败');
    console.error('Fetch playlist detail error:', error);

    // 加载模拟数据作为 fallback
    loadMockData();
  } finally {
    loading.value = false;
  }
};

const fetchPlaylistTracks = async (id: string) => {
  try {
    const tracksResponse = await getPlaylistTrackAll(id);
    console.log('Tracks response:', tracksResponse);

    // 根据实际API响应结构获取数据
    const tracks = tracksResponse?.songs || [];

    // 转换歌曲数据格式
    songs.value = tracks.map((track: any) => {
      // 获取歌手信息
      const singer = track.singerinfo?.[0] || {};
      const artistName = singer.name || '未知歌手';

      // 获取专辑信息
      const album = track.albuminfo || {};
      const albumName = album.name || '未知专辑';

      // 获取音质信息
      const qualityInfo = track.relate_goods?.[0] || {};
      const qualityLevel = qualityInfo.level || 1;

      return {
        id: track.fileid || track.hash || track.audio_id,
        name: track.name || '未知歌曲',
        artist: artistName,
        album: albumName,
        duration: formatDuration(track.timelen || 0),
        size: formatFileSize(track.size || 0),
        quality: getQualityText(qualityLevel),
        // 保存原始数据用于后续操作
        raw: track,
      };
    });
  } catch (error) {
    message.error('获取歌曲列表失败');
    console.error('Fetch playlist tracks error:', error);

    // 如果获取歌曲列表失败，使用模拟数据
    if (songs.value.length === 0) {
      songs.value = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        name: `示例歌曲 ${i + 1}`,
        artist: '示例歌手',
        album: '示例专辑',
        duration: '03:30',
        size: '8.0MB',
        quality: '标准',
        raw: {
          fileid: i + 1,
        },
      }));
    }
  }
};

const formatDuration = (seconds: number) => {
  if (!seconds) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const formatFileSize = (bytes: number) => {
  if (!bytes) return '0MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)}MB` : `${(bytes / 1024).toFixed(0)}KB`;
};

const getQualityText = (quality: number) => {
  switch (quality) {
    case 1:
      return '标准';
    case 2:
      return '高品质';
    case 3:
      return '无损';
    case 4:
      return 'Hi-Res';
    default:
      return '标准';
  }
};

const loadMockData = () => {
  const id = route.query.id as string;

  // 加载模拟数据
  Object.assign(playlist, {
    id: id,
    name: '我喜欢的音乐',
    coverImgUrl: 'https://p2.music.126.net/u_1EudmF8a5c9jP-2G3J8A==/109951165647940588.jpg',
    createTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
    playCount: 1234567,
    trackCount: 50,
    description: '这里是我最爱的歌曲列表',
    creator: {
      nickname: '用户名',
      avatarUrl: 'https://p1.music.126.net/SUeqMM8HOIpHv9Nhl9qt9w==/109951165647901116.jpg',
    },
  });

  // 加载模拟歌曲数据
  songs.value = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    name: `歌曲 ${i + 1}`,
    artist: `歌手 ${i + 1}`,
    album: `专辑 ${i + 1}`,
    duration: '03:45',
    size: '8.5MB',
    quality: '标准',
    raw: {
      fileid: i + 1,
      songname: `歌曲 ${i + 1}`,
      singername: `歌手 ${i + 1}`,
      albumname: `专辑 ${i + 1}`,
      hash: `hash_${i + 1}`,
    },
  }));
};

const playAll = () => {
  message.success('开始播放全部歌曲');
};

const handlePlay = (song: Song) => {
  message.success(`正在播放: ${song.name}`);
};

const handleDownload = (song: Song) => {
  message.success(`开始下载: ${song.name}`);
};

const handleDelete = (song: Song) => {
  message.success(`已删除: ${song.name}`);
  songs.value = songs.value.filter(s => s.id !== song.id);
};

const handleBatchPlay = (selectedSongs: Song[]) => {
  message.success(`批量播放 ${selectedSongs.length} 首歌曲`);
};

const handleBatchAdd = (selectedSongs: Song[]) => {
  playlistManagement.mode = 'add';
  playlistManagement.songs = selectedSongs;
  playlistManagement.show = true;
};

const handleBatchDownload = (selectedSongs: Song[]) => {
  batchModal.action = 'download';
  batchModal.songs = selectedSongs;
  batchModal.show = true;
};

const handleBatchDelete = (selectedSongs: Song[]) => {
  batchModal.action = 'delete';
  batchModal.songs = selectedSongs;
  batchModal.show = true;
};

const downloadAll = () => {
  message.success('开始下载全部歌曲');
};

const sharePlaylist = () => {
  message.success('分享链接已复制');
};

const showCreatePlaylist = () => {
  playlistManagement.mode = 'create';
  playlistManagement.songs = [];
  playlistManagement.show = true;
};

const handlePlaylistManagementSuccess = (newPlaylist?: any) => {
  if (newPlaylist) {
    message.success('歌单创建成功');
  }
};

const handleBatchConfirm = async (action: string, selectedSongs: Song[]) => {
  const playlistId = playlist.id;

  switch (action) {
    case 'add':
      // TODO: 实现添加到其他歌单的功能
      message.success(`已将 ${selectedSongs.length} 首歌曲添加到歌单`);
      break;

    case 'download':
      message.success(`开始下载 ${selectedSongs.length} 首歌曲`);
      break;

    case 'delete':
      try {
        // 获取要删除的歌曲的 fileids
        const fileids = selectedSongs
          .map(song => song.raw?.fileid || song.id)
          .filter(Boolean)
          .join(',');

        if (!fileids) {
          message.error('无法获取歌曲ID');
          return;
        }

        // 调用删除API
        await deletePlaylistTrack(playlistId, fileids);

        // 从列表中移除已删除的歌曲
        songs.value = songs.value.filter(song => !selectedSongs.some(s => s.id === song.id));

        message.success(`已成功删除 ${selectedSongs.length} 首歌曲`);

        // 刷新歌单信息以更新歌曲数量
        playlist.trackCount = songs.value.length;
      } catch (error) {
        message.error('删除歌曲失败');
        console.error('Delete playlist tracks error:', error);
      }
      break;
  }
};

// 监听 playlistId 变化
watch(
  () => props.playlistId,
  newId => {
    if (newId) {
      fetchPlaylistDetail();
    }
  },
  { immediate: true },
);

onMounted(() => {
  // 如果没有传入 playlistId，使用路由参数
  if (!props.playlistId) {
    fetchPlaylistDetail();
  }
});
</script>

<style scoped>
.playlist-detail {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.playlist-header {
  display: flex;
  gap: 24px;
  margin-bottom: 32px;
}

.cover {
  flex-shrink: 0;
  width: 200px;
  height: 200px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.cover :deep(img) {
  width: 100%;
  height: 100%;
}

.info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
}

.creator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.create-time {
  margin-left: auto;
}

.stats {
  display: flex;
  gap: 24px;
}

.stats .n-text {
  display: flex;
  align-items: center;
  gap: 4px;
}

.description {
  line-height: 1.6;
}

.actions {
  margin-top: 8px;
}

.songs-section {
  background: var(--n-card-color);
  border-radius: 8px;
  padding: 20px;
}
</style>
