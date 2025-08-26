<template>
  <NModal
    :show="show"
    @update:show="$emit('update:show', $event)"
    :mask-closable="true"
    preset="card"
    title="批量操作"
    style="width: 600px; max-width: 90vw"
  >
    <NSpace vertical :size="16">
      <div class="selected-info">
        <NText>已选择 {{ selectedCount }} 首歌曲</NText>
      </div>

      <NForm :model="formModel" :rules="rules" ref="formRef">
        <!-- 添加到歌单 -->
        <NFormItem v-if="action === 'add'" label="选择歌单" path="playlistId">
          <NSelect
            v-model:value="formModel.playlistId"
            placeholder="请选择目标歌单"
            :options="playlistOptions"
            clearable
          />
        </NFormItem>

        <!-- 下载设置 -->
        <template v-if="action === 'download'">
          <NFormItem label="音质选择" path="quality">
            <NSelect
              v-model:value="formModel.quality"
              placeholder="请选择音质"
              :options="qualityOptions"
            />
          </NFormItem>
          <NFormItem label="下载路径" path="downloadPath">
            <NInput v-model:value="formModel.downloadPath" placeholder="请选择下载路径">
              <template #suffix>
                <NButton text @click="selectDownloadPath">
                  <template #icon>
                    <NIcon :component="FolderOutline" />
                  </template>
                </NButton>
              </template>
            </NInput>
          </NFormItem>
        </template>
      </NForm>

      <!-- 操作预览 -->
      <div class="preview-section">
        <NH3 prefix="bar">操作预览</NH3>
        <NScrollbar style="max-height: 200px">
          <NList>
            <NListItem v-for="song in previewSongs" :key="song.id">
              <div class="preview-item">
                <NText>{{ song.name }}</NText>
                <NText depth="3">- {{ song.artist }}</NText>
              </div>
            </NListItem>
          </NList>
        </NScrollbar>
      </div>
    </NSpace>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="handleCancel">取消</NButton>
        <NButton type="primary" :loading="loading" @click="handleConfirm">
          确认{{ actionText }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<script setup lang="ts">
import {
  NModal,
  NSpace,
  NText,
  NForm,
  NFormItem,
  NSelect,
  NInput,
  NButton,
  NIcon,
  NH3,
  NScrollbar,
  NList,
  NListItem,
} from 'naive-ui';
import { ref, reactive, computed, watch } from 'vue';
import { FolderOutline } from '@vicons/ionicons5';
import type { Song } from './SongList.vue';
import { useNaiveDiscreteApi } from '@/hooks';

interface Props {
  show: boolean;
  action: 'add' | 'download' | 'delete';
  songs: Song[];
}

const props = withDefaults(defineProps<Props>(), {
  show: false,
});

const emit = defineEmits<{
  'update:show': [value: boolean];
  confirm: [action: string, songs: Song[], options?: any];
}>();

const { message } = useNaiveDiscreteApi();
const formRef = ref();

const formModel = reactive({
  playlistId: null,
  quality: 'standard',
  downloadPath: '',
});

const rules = {
  playlistId: {
    required: true,
    message: '请选择目标歌单',
    trigger: 'change',
  },
  quality: {
    required: true,
    message: '请选择音质',
    trigger: 'change',
  },
  downloadPath: {
    required: true,
    message: '请选择下载路径',
    trigger: 'input',
  },
};

const loading = ref(false);

// 模拟歌单列表
const playlistOptions = [
  { label: '我喜欢的音乐', value: '1' },
  { label: '经典老歌', value: '2' },
  { label: '轻音乐', value: '3' },
  { label: '运动歌单', value: '4' },
];

// 音质选项
const qualityOptions = [
  { label: '标准音质', value: 'standard' },
  { label: '高品质', value: 'high' },
  { label: '无损音质', value: 'lossless' },
  { label: 'Hi-Res', value: 'hires' },
];

const selectedCount = computed(() => props.songs.length);
const actionText = computed(() => {
  switch (props.action) {
    case 'add':
      return '添加';
    case 'download':
      return '下载';
    case 'delete':
      return '删除';
    default:
      return '操作';
  }
});

const previewSongs = computed(() => props.songs.slice(0, 10));

const selectDownloadPath = () => {
  // 这里应该调用系统文件选择器
  formModel.downloadPath = '/Users/Music/Downloads';
  message.success('已选择下载路径');
};

const handleCancel = () => {
  emit('update:show', false);
};

const handleConfirm = async () => {
  if (props.action === 'delete') {
    // 删除操作不需要表单验证
    loading.value = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      emit('confirm', props.action, props.songs);
      message.success(`已成功删除 ${selectedCount.value} 首歌曲`);
      emit('update:show', false);
    } catch {
      message.error('操作失败');
    } finally {
      loading.value = false;
    }
    return;
  }

  if (!formRef.value) return;

  formRef.value.validate(async (errors: any) => {
    if (errors) return;

    loading.value = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      emit('confirm', props.action, props.songs, { ...formModel });
      message.success(`批量${actionText.value}成功`);
      emit('update:show', false);
    } catch {
      message.error('操作失败');
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
      formModel.playlistId = null;
      formModel.quality = 'standard';
      formModel.downloadPath = '';
      formRef.value?.restoreValidation();
    }
  },
);
</script>

<style scoped>
.selected-info {
  padding: 12px;
  background: var(--n-color-modal);
  border-radius: 4px;
}

.preview-section {
  margin-top: 16px;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
