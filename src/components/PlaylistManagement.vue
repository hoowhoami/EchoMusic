<template>
  <NModal
    :show="show"
    @update:show="$emit('update:show', $event)"
    :mask-closable="true"
    preset="card"
    :title="title || (mode === 'create' ? createPlaylistLabel : addPlaylistLabel)"
    style="width: 500px; max-width: 90vw"
  >
    <NForm ref="formRef" :model="formModel" :rules="rules" label-placement="left" label-width="100">
      <!-- 创建歌单表单 -->
      <template v-if="mode === 'create'">
        <NFormItem label="歌单名称" path="name">
          <NInput
            v-model:value="formModel.name"
            placeholder="请输入歌单名称"
            maxlength="50"
            show-count
          />
        </NFormItem>

        <NFormItem v-if="showDescription" label="歌单描述" path="description">
          <NInput
            v-model:value="formModel.description"
            type="textarea"
            placeholder="请输入歌单描述（可选）"
            :rows="3"
            maxlength="200"
            show-count
          />
        </NFormItem>

        <NFormItem v-if="showPrivacy" label="隐私设置" path="isPrivate">
          <NSwitch v-model:value="formModel.isPrivate">
            <template #checked>私密歌单</template>
            <template #unchecked>公开歌单</template>
          </NSwitch>
        </NFormItem>
      </template>

      <!-- 添加到歌单表单 -->
      <template v-else-if="mode === 'add'">
        <NFormItem label="选择歌单" path="playlistId">
          <NSelect
            v-model:value="formModel.playlistId"
            placeholder="请选择目标歌单"
            :options="playlistOptions"
            :loading="loadingPlaylists"
          />
        </NFormItem>

        <div class="selected-songs-info">
          <NText>将要添加 {{ songs.length }} 首歌曲</NText>
        </div>
      </template>
    </NForm>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="handleCancel">取消</NButton>
        <NButton type="primary" :loading="loading" @click="handleSubmit">
          {{ mode === 'create' ? '创建' : '添加' }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<script setup lang="ts">
import {
  NModal,
  NForm,
  NFormItem,
  NInput,
  NSwitch,
  NSelect,
  NButton,
  NSpace,
  NText,
  FormInst,
  FormRules,
} from 'naive-ui';
import { ref, reactive, computed, watch } from 'vue';
import type { Song } from './SongList.vue';
import { useNaiveDiscreteApi } from '@/hooks';
import { addPlaylist, getPlaylist, addPlaylistTrack } from '@/api/playlist';

interface Props {
  show: boolean;
  mode: 'create' | 'add';
  songs?: Song[];
  // 自定义配置
  title?: string;
  createPlaylistLabel?: string;
  addPlaylistLabel?: string;
  showDescription?: boolean;
  showPrivacy?: boolean;
  excludePlaylistIds?: string[]; // 排除的歌单ID列表
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
  mode: 'create',
  songs: () => [],
  title: '',
  createPlaylistLabel: '创建歌单',
  addPlaylistLabel: '添加到歌单',
  showDescription: true,
  showPrivacy: true,
  excludePlaylistIds: () => [],
});

const emit = defineEmits<{
  'update:show': [value: boolean];
  success: [playlist?: any];
}>();

const { message } = useNaiveDiscreteApi();
const formRef = ref<FormInst | null>(null);

const loading = ref(false);
const loadingPlaylists = ref(false);

const formModel = reactive({
  name: '',
  description: '',
  isPrivate: false,
  playlistId: null,
});

const rules: FormRules = {
  name: {
    required: true,
    message: '请输入歌单名称',
    trigger: 'blur',
  },
  playlistId: {
    required: true,
    message: '请选择目标歌单',
    trigger: 'change',
  },
};

// 用户歌单列表
const userPlaylists = ref<any[]>([]);

const playlistOptions = computed(() => {
  return userPlaylists.value
    .filter(
      playlist =>
        !props.excludePlaylistIds.includes(playlist.global_collection_id || playlist.id || ''),
    )
    .map(playlist => ({
      label: playlist.name,
      value: playlist.global_collection_id || playlist.id,
    }));
});

// 获取用户歌单列表
const fetchUserPlaylists = async () => {
  if (props.mode !== 'add') return;

  loadingPlaylists.value = true;
  try {
    const response = await getPlaylist();
    userPlaylists.value = response.data?.list || [];
  } catch (error) {
    message.error('获取歌单列表失败');
    console.error('Fetch user playlists error:', error);
  } finally {
    loadingPlaylists.value = false;
  }
};

const handleCancel = () => {
  emit('update:show', false);
};

const handleSubmit = async () => {
  if (!formRef.value) return;

  formRef.value.validate(async (errors: any) => {
    if (errors) return;

    loading.value = true;
    try {
      if (props.mode === 'create') {
        // 创建新歌单
        const response = await addPlaylist(formModel.name, formModel.isPrivate ? 1 : 0);

        message.success('歌单创建成功');
        emit('success', response.data);
      } else if (props.mode === 'add') {
        // 添加歌曲到歌单
        const playlistId = String(formModel.playlistId);

        // 构建歌曲数据字符串
        const songsData = props.songs
          .map(song => {
            const raw = song.raw;
            return `${raw?.songname || song.name}|${raw?.hash || song.id}|${raw?.album_id || ''}|${raw?.mixsongid || raw?.album_audio_id || ''}`;
          })
          .join(',');

        await addPlaylistTrack(playlistId, songsData);

        message.success(`已成功添加 ${props.songs.length} 首歌曲到歌单`);
        emit('success');
      }

      emit('update:show', false);
    } catch (error) {
      message.error(props.mode === 'create' ? '创建歌单失败' : '添加歌曲失败');
      console.error('Playlist management error:', error);
    } finally {
      loading.value = false;
    }
  });
};

// 重置表单
watch(
  () => props.show,
  val => {
    if (val) {
      formModel.name = '';
      formModel.description = '';
      formModel.isPrivate = false;
      formModel.playlistId = null;
      formRef.value?.restoreValidation();

      if (props.mode === 'add') {
        fetchUserPlaylists();
      }
    }
  },
);
</script>

<style scoped>
.selected-songs-info {
  padding: 12px;
  background: var(--n-color-modal);
  border-radius: 4px;
  text-align: center;
}
</style>
