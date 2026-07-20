<script setup lang="ts">
import { computed, ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import type { AudioQualityValue } from '@/types';
import Switch from '@/components/ui/Switch.vue';
import Slider from '@/components/ui/Slider.vue';
import InputNumber from '@/components/ui/InputNumber.vue';
import Select from '@/components/ui/Select.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconPencil, iconPlayerPlay, iconPlus, iconTrash, iconX } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { audioQualityOptions, sectionTitles } from '../constants';
import { normalizeImpulseResponseName, type ImpulseResponseFile } from '../../../../shared/audio';

const settingStore = useSettingStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();
const isImportingImpulseResponse = ref(false);
const showImpulseResponseDialog = ref(false);
const editingImpulseResponseId = ref('');
const impulseResponseNameDraft = ref('');

const selectedImpulseResponse = computed(() => settingStore.getSelectedImpulseResponse());

const autoNextDelayInput = computed({
  get: () => String(settingStore.autoNextDelaySeconds ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextDelaySeconds = Number.isNaN(parsed)
      ? 0
      : Math.max(0, Math.min(parsed, 600));
  },
});

const autoNextMaxAttemptsInput = computed({
  get: () => String(settingStore.autoNextMaxAttempts ?? 0),
  set: (value: string | number) => {
    const parsed = Number.parseInt(String(value).trim(), 10);
    settingStore.autoNextMaxAttempts = Number.isNaN(parsed)
      ? 1
      : Math.max(1, Math.min(parsed, 999));
  },
});

const handleVolumeNormalizationChange = (enabled: boolean) => {
  settingStore.volumeNormalization = enabled;
  playerStore.setVolumeNormalization(enabled);
};

const handleReferenceLufsSlider = (value: number) => {
  settingStore.volumeNormalizationLufs = value;
  playerStore.setReferenceLufs(value);
};

const getImpulseResponseDisplayName = (name: string) => normalizeImpulseResponseName(name);

const beginRenameImpulseResponse = (file: ImpulseResponseFile) => {
  editingImpulseResponseId.value = file.id;
  impulseResponseNameDraft.value = getImpulseResponseDisplayName(file.name);
};

const cancelRenameImpulseResponse = () => {
  editingImpulseResponseId.value = '';
  impulseResponseNameDraft.value = '';
};

const commitRenameImpulseResponse = (id: string) => {
  settingStore.renameImpulseResponseFile(id, impulseResponseNameDraft.value);
  cancelRenameImpulseResponse();
};

const handleImpulseResponseEnabledChange = (enabled: boolean) => {
  if (enabled && !selectedImpulseResponse.value) {
    toastStore.warning('请先导入空间音效文件');
    return;
  }
  settingStore.impulseResponseEnabled = enabled;
};

const handleImportImpulseResponse = async () => {
  if (!window.electron?.audioEffects || isImportingImpulseResponse.value) return;
  isImportingImpulseResponse.value = true;
  try {
    const result = await window.electron.audioEffects.importImpulseResponse();
    if (result.canceled) return;
    const files = result.files?.length ? result.files : result.file ? [result.file] : [];
    if (files.length === 0) {
      toastStore.warning(result.error || '空间音效文件导入失败');
      return;
    }
    settingStore.addImpulseResponseFiles(files);
    if (result.errors?.length) {
      toastStore.warning(`已导入 ${files.length} 个音效文件，${result.errors.length} 个失败`, 4200);
    } else {
      toastStore.success(
        files.length === 1 ? '空间音效文件已导入' : `已导入 ${files.length} 个音效文件`,
      );
    }
  } catch {
    toastStore.actionFailed('导入空间音效文件');
  } finally {
    isImportingImpulseResponse.value = false;
  }
};

const handleRemoveImpulseResponse = (id: string) => {
  settingStore.removeImpulseResponseFile(id);
  toastStore.actionCompleted('已移除音效文件');
};
</script>

<template>
  <SettingsSectionShell id="playback" :title="sectionTitles.playback.label">
    <template #icon>
      <Icon :icon="iconPlayerPlay" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">播放替换队列</h3>
        <p class="text-sm text-text-secondary">双击播放单曲时用当前列表替换播放队列</p>
      </div>
      <Switch v-model="settingStore.replacePlaylist" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">启动时自动播放</h3>
        <p class="text-sm text-text-secondary">打开应用时如果有恢复的播放会话则自动开始播放</p>
      </div>
      <Switch v-model="settingStore.autoPlayOnLaunch" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">默认音质</h3>
        <p class="text-sm text-text-secondary">
          新歌曲默认按此音质解析，播放器中可临时覆盖当前歌曲
        </p>
      </div>
      <Select
        class="w-45"
        :model-value="settingStore.defaultAudioQuality"
        :options="audioQualityOptions"
        @update:model-value="settingStore.defaultAudioQuality = $event as AudioQualityValue"
      />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">智能兼容模式</h3>
        <p class="text-sm text-text-secondary">首选音质不可用时自动尝试备选</p>
      </div>
      <Switch v-model="settingStore.compatibilityMode" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">无缝播放</h3>
        <p class="text-sm text-text-secondary">提前准备下一首，减少歌曲衔接时的停顿</p>
      </div>
      <Switch v-model="settingStore.gaplessPlayback" />
    </div>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">淡入淡出播放</h3>
        <p class="text-sm text-text-secondary">启用歌曲切换时的过渡效果</p>
      </div>
      <Switch v-model="settingStore.volumeFade" />
    </div>
    <template v-if="settingStore.volumeFade">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">淡入淡出时长</h3>
          <p class="text-sm text-text-secondary">调整歌曲切换时的过渡时长</p>
        </div>
        <Slider
          class="w-48"
          :model-value="settingStore.volumeFadeTime"
          :min="500"
          :max="3000"
          :step="100"
          show-value
          :value-suffix="'ms'"
          @update:model-value="settingStore.volumeFadeTime = $event"
          @value-commit="settingStore.volumeFadeTime = $event"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音量均衡</h3>
        <p class="text-sm text-text-secondary">自动调整不同歌曲的音量，使播放响度保持一致</p>
      </div>
      <Switch
        :model-value="settingStore.volumeNormalization"
        @update:model-value="handleVolumeNormalizationChange"
      />
    </div>
    <template v-if="settingStore.volumeNormalization">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">参考响度</h3>
          <p class="text-sm text-text-secondary">数值越高整体音量越大，越低越安静</p>
        </div>
        <Slider
          class="w-48"
          :model-value="settingStore.volumeNormalizationLufs"
          :min="-20"
          :max="-8"
          :step="1"
          show-value
          :value-suffix="' LUFS'"
          @update:model-value="handleReferenceLufsSlider($event)"
          @value-commit="handleReferenceLufsSlider($event)"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">空间音效</h3>
        <p class="text-sm text-text-secondary">导入本地音频文件，用作播放时的空间音效</p>
      </div>
      <div class="irs-actions">
        <Button variant="outline" size="xs" type="button" @click="showImpulseResponseDialog = true">
          <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
          添加
        </Button>
        <Switch
          :model-value="settingStore.impulseResponseEnabled"
          :disabled="settingStore.impulseResponseFiles.length === 0"
          @update:model-value="handleImpulseResponseEnabledChange"
        />
      </div>
    </div>

    <Dialog
      v-model:open="showImpulseResponseDialog"
      title="空间音效"
      showClose
      :content-style="{ width: '420px' }"
    >
      <div v-if="settingStore.impulseResponseFiles.length > 0" class="irs-list">
        <div
          v-for="file in settingStore.impulseResponseFiles"
          :key="file.id"
          class="irs-file-row"
          :class="{ 'is-active': file.id === settingStore.selectedImpulseResponseId }"
        >
          <span class="irs-file-main">
            <input
              v-if="editingImpulseResponseId === file.id"
              v-model="impulseResponseNameDraft"
              class="irs-rename-input"
              type="text"
              maxlength="40"
              @keydown.enter.prevent="commitRenameImpulseResponse(file.id)"
              @keydown.esc.prevent="cancelRenameImpulseResponse"
            />
            <span v-else class="irs-file-name">{{ getImpulseResponseDisplayName(file.name) }}</span>
          </span>
          <button
            v-if="editingImpulseResponseId === file.id"
            type="button"
            class="irs-row-btn"
            title="保存名称"
            @click.stop="commitRenameImpulseResponse(file.id)"
          >
            <Icon :icon="iconCheckMark" width="14" height="14" />
          </button>
          <button
            v-if="editingImpulseResponseId === file.id"
            type="button"
            class="irs-row-btn"
            title="取消重命名"
            @click.stop="cancelRenameImpulseResponse"
          >
            <Icon :icon="iconX" width="14" height="14" />
          </button>
          <button
            v-else
            type="button"
            class="irs-row-btn"
            title="重命名"
            @click.stop="beginRenameImpulseResponse(file)"
          >
            <Icon :icon="iconPencil" width="14" height="14" />
          </button>
          <button
            type="button"
            class="irs-row-btn is-danger"
            title="移除音效文件"
            @click.stop="handleRemoveImpulseResponse(file.id)"
          >
            <Icon :icon="iconTrash" width="14" height="14" />
          </button>
        </div>
      </div>
      <div v-else class="irs-empty">暂无音效文件</div>

      <template #footer>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :loading="isImportingImpulseResponse"
          @click="handleImportImpulseResponse"
        >
          <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
          导入音效文件
        </Button>
      </template>
    </Dialog>

    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">自动跳过错误</h3>
        <p class="text-sm text-text-secondary">
          播放失败时停留在当前歌曲，并按设定延迟自动尝试下一首
        </p>
      </div>
      <Switch v-model="settingStore.autoNext" />
    </div>
    <template v-if="settingStore.autoNext">
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">失败后切换延迟</h3>
          <p class="text-sm text-text-secondary">给用户留出确认失败状态的时间，再自动切换</p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="autoNextDelayInput"
          :min="0"
          :max="600"
          :step="1"
          placeholder="0"
          suffix="秒"
          @update:model-value="autoNextDelayInput = $event"
        />
      </div>
      <div class="settings-divider"></div>
      <div class="settings-item">
        <div class="space-y-1">
          <h3 class="font-semibold">最大自动切换次数</h3>
          <p class="text-sm text-text-secondary">连续失败时最多自动尝试的次数，避免无限跳歌</p>
        </div>
        <InputNumber
          class="w-45"
          :model-value="autoNextMaxAttemptsInput"
          :min="1"
          :max="999"
          :step="1"
          placeholder="10"
          suffix="次"
          @update:model-value="autoNextMaxAttemptsInput = $event"
        />
      </div>
    </template>
    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">防止系统休眠</h3>
        <p class="text-sm text-text-secondary">播放音乐时阻止系统进入睡眠</p>
      </div>
      <Switch v-model="settingStore.preventSleep" />
    </div>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
<style scoped>
.irs-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.irs-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow: auto;
}

.irs-file-row {
  min-width: 0;
  width: 100%;
  height: 48px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 3%, transparent);
  border-radius: 8px;
  padding: 0 10px 0 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--color-text-main);
  transition: all 0.2s;
}

.irs-file-row.is-active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.irs-file-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
}

.irs-file-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 700;
}

.irs-rename-input {
  width: 100%;
  min-width: 0;
  height: 30px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 45%, transparent);
  background: color-mix(in srgb, var(--color-text-main) 4%, transparent);
  padding: 0 8px;
  color: var(--color-text-main);
  font-size: 12px;
  font-weight: 700;
  outline: none;
}

.irs-row-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  flex-shrink: 0;
  transition: all 0.2s;
}

.irs-row-btn:hover {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.irs-row-btn.is-danger:hover {
  color: var(--state-danger);
  background: color-mix(in srgb, var(--state-danger) 10%, transparent);
}

.irs-empty {
  height: 96px;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, var(--color-text-main) 16%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 650;
}
</style>
