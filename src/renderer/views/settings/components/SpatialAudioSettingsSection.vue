<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { TabsRoot, TabsList, TabsTrigger, TabsContent } from 'reka-ui';
import { useSettingStore } from '@/stores/setting';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { Icon } from '@iconify/vue';
import { iconCheckMark, iconPencil, iconPlus, iconTrash, iconX } from '@/icons';
import SettingsSectionShell from './SettingsSectionShell.vue';
import { sectionTitles } from '../constants';
import { normalizeAudioEffectName } from '../../../../shared/audio';
import type { DspProviderInspection } from '../../../../shared/audio';
import type { DspProviderManifest } from '../../../../shared/player-audio-graph';

const settingStore = useSettingStore();
const playerStore = usePlayerStore();
const toastStore = useToastStore();
const importing = ref(false);
const showFileDialog = ref(false);
const showProviderDialog = ref(false);
const activeFileTab = ref<string>('local');
const providerFiles = ref<string[]>([]);
const providerInspections = ref<Record<string, DspProviderInspection | null>>({});
const editingFileId = ref('');
const fileNameDraft = ref('');
const files = computed(() => settingStore.impulseResponseFiles);
const fileCategories = [
  { id: 'local', label: '本地导入' },
  { id: 'artist', label: '歌手音效' },
  { id: 'headphone', label: '耳机音效' },
  { id: 'market', label: '音效市场' },
] as const;
const fileGroups = computed(() =>
  fileCategories.map((group) => ({
    ...group,
    files: files.value.filter((file) => {
      const source =
        file.kind === 'imported-ir'
          ? 'local'
          : file.source === 'artist' || file.source === 'headphone'
            ? file.source
            : 'market';
      return source === group.id;
    }),
  })),
);
const providerGraph = computed(() => playerStore.playbackDiagnostics.graph);
const currentProviderPath = computed(
  () =>
    providerGraph.value?.providerPath ||
    (settingStore.dspProviderEnabled ? settingStore.dspProviderPath : ''),
);
const hasImportedProvider = computed(
  () => providerFiles.value.length > 0 || !!currentProviderPath.value,
);

const parseProviderManifest = (path: string): DspProviderManifest | null => {
  const manifestJson = providerInspections.value[path]?.manifestJson;
  if (!manifestJson) return null;
  try {
    const manifest = JSON.parse(manifestJson) as DspProviderManifest;
    return typeof manifest === 'object' && manifest !== null ? manifest : null;
  } catch {
    return null;
  }
};

const providerDisplayName = (path: string) => {
  const manifest = parseProviderManifest(path);
  const info = providerInspections.value[path];
  return manifest?.displayName?.trim() || info?.providerId || path.split('/').pop() || '音效引擎';
};

const providerDescription = (path: string) =>
  parseProviderManifest(path)?.description?.trim() || '';

const providerTechnicalInfo = (path: string) => {
  const info = providerInspections.value[path];
  if (!info) return '引擎信息读取失败';
  return `${info.providerId} · v${info.providerVersion}`;
};

const resourceDisplayName = (kind: string) => {
  const normalized = kind.trim().toLowerCase();
  if (normalized === 'vpf') return 'VPF 参数音效';
  if (normalized === 'impulse-response') return '脉冲响应';
  return kind;
};

const providerCapabilities = (path: string) => {
  const info = providerInspections.value[path];
  const manifest = parseProviderManifest(path);
  if (!info) return ['能力信息不可用'];

  const capabilities = (manifest?.resources ?? []).map((resource) =>
    resource.extensions?.length
      ? `${resourceDisplayName(resource.kind)} ${resource.extensions.join(' / ')}`
      : resourceDisplayName(resource.kind),
  );
  if (manifest?.presets?.length) capabilities.push(`${manifest.presets.length} 个预设`);
  if (manifest?.controls?.length) capabilities.push(`${manifest.controls.length} 项可调参数`);
  if (info.maxChannels > 0) capabilities.push(`最高 ${info.maxChannels} 声道`);
  capabilities.push(info.latencyFrames > 0 ? `${info.latencyFrames} 帧延迟` : '零额外延迟');
  return capabilities;
};

const providerFileName = (path: string) => path.split('/').pop() || path;

onMounted(async () => {
  await refreshProviders();
});

const refreshProviders = async () => {
  providerFiles.value = await window.electron.player.listDspProviders();
  const entries = await Promise.all(
    providerFiles.value.map(async (path) => {
      try {
        return [path, await window.electron.player.inspectDspProvider(path)] as const;
      } catch {
        return [path, null] as const;
      }
    }),
  );
  providerInspections.value = Object.fromEntries(entries);
};

const importFiles = async () => {
  if (importing.value) return;
  importing.value = true;
  try {
    const result = await window.electron.audioEffects.importImpulseResponse();
    if (result.canceled) return;
    const imported = result.files?.length ? result.files : result.file ? [result.file] : [];
    if (!imported.length) throw new Error(result.error || '音效文件导入失败');
    settingStore.addImpulseResponseFiles(imported);
    activeFileTab.value = 'local';
    toastStore.success(`已导入 ${imported.length} 个音效文件`);
  } catch (error) {
    toastStore.warning(error instanceof Error ? error.message : '音效文件导入失败');
  } finally {
    importing.value = false;
  }
};

const importProvider = async () => {
  try {
    const providerPath = await window.electron.player.selectDspProvider();
    if (!providerPath) return;
    await window.electron.player.setAudioEffect({ providerPath, providerMode: 'speaker' });
    settingStore.configureDspProvider(providerPath, 'speaker');
    await refreshProviders();
    toastStore.success('音效引擎已导入并启用');
  } catch (error) {
    toastStore.warning(`音效引擎导入失败: ${String(error)}`);
  }
};

const openProviderDialog = async () => {
  await refreshProviders();
  showProviderDialog.value = true;
};

const activateProvider = async (
  providerPath: string,
  mode = providerGraph.value?.providerMode ??
    (settingStore.dspProviderMode === 'headphone' ? 'headphone' : 'speaker'),
) => {
  try {
    await window.electron.player.setAudioEffect({
      providerPath,
      providerMode: mode,
    });
    settingStore.configureDspProvider(providerPath, mode);
    toastStore.success(`已启用“${providerDisplayName(providerPath)}”`);
  } catch (error) {
    toastStore.warning(`音效引擎启用失败: ${String(error)}`);
  }
};

const deactivateProvider = async (providerPath: string) => {
  if (providerPath !== currentProviderPath.value) return;
  const selectedEffect = settingStore.getSelectedImpulseResponse();
  const requiresEngine = !!selectedEffect?.vpfPath;
  const fallbackEffect =
    settingStore.impulseResponseEnabled && !requiresEngine && selectedEffect?.impulseResponsePath
      ? { impulseResponsePath: selectedEffect.impulseResponsePath }
      : null;
  try {
    await window.electron.player.setAudioEffect(fallbackEffect);
    settingStore.disableDspProvider();
    if (requiresEngine) settingStore.impulseResponseEnabled = false;
    const graph = await window.electron.player.getAudioGraph();
    playerStore.playbackDiagnostics.graph = graph ? { ...graph, updatedAt: Date.now() } : null;
    toastStore.success(`已停用“${providerDisplayName(providerPath)}”`);
  } catch (error) {
    toastStore.warning(`音效引擎停用失败: ${String(error)}`);
  }
};

const removeProvider = async (providerPath: string) => {
  try {
    const removingActiveProvider = providerPath === currentProviderPath.value;
    await window.electron.player.deleteDspProvider(providerPath);
    if (removingActiveProvider) {
      settingStore.disableDspProvider();
    }
    await refreshProviders();
    toastStore.success('音效引擎已删除');
  } catch (error) {
    toastStore.warning(`音效引擎删除失败: ${String(error)}`);
  }
};

const removeFile = (id: string) => {
  settingStore.removeImpulseResponseFile(id);
  toastStore.success('已移除音效');
};

const beginRename = (id: string, name: string) => {
  editingFileId.value = id;
  fileNameDraft.value = normalizeAudioEffectName(name);
};

const cancelRename = () => {
  editingFileId.value = '';
  fileNameDraft.value = '';
};

const commitRename = (id: string) => {
  const name = fileNameDraft.value.trim();
  if (name) settingStore.renameImpulseResponseFile(id, name);
  cancelRename();
};
</script>

<template>
  <SettingsSectionShell id="spatialAudio" :title="sectionTitles.spatialAudio.label">
    <template #icon>
      <Icon :icon="sectionTitles.spatialAudio.icon" width="20" height="20" class="text-primary" />
    </template>

    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">音效文件</h3>
        <p class="text-sm text-text-secondary">
          {{ files.length }} 个文件，按本地导入、歌手音效、耳机音效和音效市场分类管理
        </p>
      </div>
      <Button variant="outline" size="xs" type="button" @click="showFileDialog = true"
        >管理文件</Button
      >
    </div>

    <div class="settings-divider"></div>
    <div class="settings-item">
      <div class="space-y-1">
        <h3 class="font-semibold">第三方音效引擎</h3>
        <p class="text-sm text-text-secondary">
          {{
            hasImportedProvider
              ? `已安装 ${providerFiles.length} 个音效引擎`
              : '未安装第三方音效引擎'
          }}
        </p>
      </div>
      <Button variant="outline" size="xs" type="button" @click="openProviderDialog"
        >管理引擎</Button
      >
    </div>

    <Dialog
      v-model:open="showFileDialog"
      title="音效文件"
      showClose
      :content-style="{ width: '520px', maxWidth: 'calc(100vw - 32px)' }"
    >
      <TabsRoot v-model="activeFileTab" @update:model-value="cancelRename">
        <TabsList class="file-tabs" aria-label="音效文件分类">
          <TabsTrigger
            v-for="group in fileGroups"
            :key="group.id"
            :value="group.id"
            class="file-tab"
          >
            <span>{{ group.label }}</span>
            <small>{{ group.files.length }}</small>
          </TabsTrigger>
        </TabsList>
        <TabsContent v-for="group in fileGroups" :key="group.id" :value="group.id">
          <div class="spatial-file-list space-y-2">
            <div v-for="file in group.files" :key="file.id" class="spatial-file-row">
              <input
                v-if="editingFileId === file.id"
                v-model="fileNameDraft"
                class="spatial-file-name-input"
                type="text"
                maxlength="80"
                @keydown.enter.prevent="commitRename(file.id)"
                @keydown.esc.prevent="cancelRename"
              />
              <span v-else class="spatial-file-select">{{
                normalizeAudioEffectName(file.name)
              }}</span>
              <button
                v-if="editingFileId === file.id"
                type="button"
                class="spatial-file-action"
                title="保存名称"
                @click="commitRename(file.id)"
              >
                <Icon :icon="iconCheckMark" width="14" height="14" />
              </button>
              <button
                v-if="editingFileId === file.id"
                type="button"
                class="spatial-file-action"
                title="取消"
                @click="cancelRename"
              >
                <Icon :icon="iconX" width="14" height="14" />
              </button>
              <button
                v-else
                type="button"
                class="spatial-file-action"
                title="重命名"
                @click="beginRename(file.id, file.name)"
              >
                <Icon :icon="iconPencil" width="14" height="14" />
              </button>
              <button
                type="button"
                class="spatial-file-delete"
                title="移除"
                @click="removeFile(file.id)"
              >
                <Icon :icon="iconTrash" width="14" height="14" />
              </button>
            </div>
            <div v-if="group.files.length === 0" class="spatial-empty">
              {{ group.id === 'local' ? '暂无本地导入音效' : '此分类暂无已下载音效' }}
            </div>
          </div>
        </TabsContent>
      </TabsRoot>
      <template #footer>
        <Button
          v-if="activeFileTab === 'local'"
          variant="outline"
          size="sm"
          type="button"
          :loading="importing"
          @click="importFiles"
          ><Icon :icon="iconPlus" width="14" height="14" class="mr-1" />导入本地文件</Button
        >
        <span v-else class="file-download-hint">请在播放器的「音效广场」中下载对应分类的音效</span>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showProviderDialog"
      title="音效引擎"
      showClose
      :content-style="{ width: '520px' }"
    >
      <div class="engine-card-list">
        <article
          v-for="providerPath in providerFiles"
          :key="providerPath"
          class="engine-card"
          :class="{ 'is-active': providerPath === currentProviderPath }"
        >
          <div class="engine-card-header">
            <div class="engine-identity">
              <div class="engine-name-row">
                <strong>{{ providerDisplayName(providerPath) }}</strong>
                <span v-if="providerPath === currentProviderPath" class="engine-active-badge">
                  使用中
                </span>
              </div>
              <span class="engine-technical-info">{{ providerTechnicalInfo(providerPath) }}</span>
            </div>
            <button
              type="button"
              class="spatial-file-delete engine-delete"
              title="删除音效引擎"
              @click="removeProvider(providerPath)"
            >
              <Icon :icon="iconTrash" width="15" height="15" />
            </button>
          </div>

          <p v-if="providerDescription(providerPath)" class="engine-description">
            {{ providerDescription(providerPath) }}
          </p>

          <div class="engine-capabilities" aria-label="引擎能力">
            <span
              v-for="capability in providerCapabilities(providerPath)"
              :key="capability"
              class="engine-capability"
            >
              {{ capability }}
            </span>
          </div>

          <div class="engine-card-footer">
            <span class="engine-file-name" :title="providerPath">
              {{ providerFileName(providerPath) }}
            </span>
            <Button
              variant="outline"
              size="xs"
              type="button"
              @click="
                providerPath === currentProviderPath
                  ? deactivateProvider(providerPath)
                  : activateProvider(providerPath)
              "
            >
              {{ providerPath === currentProviderPath ? '停用' : '启用' }}
            </Button>
          </div>
        </article>
        <div v-if="providerFiles.length === 0" class="spatial-empty">暂无已安装的音效引擎</div>
      </div>
      <template #footer>
        <Button variant="outline" size="sm" type="button" @click="importProvider">
          <Icon :icon="iconPlus" width="14" height="14" class="mr-1" />
          导入音效引擎
        </Button>
      </template>
    </Dialog>
  </SettingsSectionShell>
</template>

<style scoped src="../settingsSection.css"></style>
<style scoped>
.spatial-file-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 10%, transparent);
  border-radius: 8px;
}
.spatial-file-list {
  max-height: min(360px, 50vh);
  overflow-y: auto;
  padding-right: 4px;
}
.spatial-file-row {
  min-height: 52px;
}
.spatial-file-row.is-active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.spatial-file-select {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  text-align: left;
  color: var(--color-text-main);
}
.spatial-file-select {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spatial-file-name-input {
  min-width: 0;
  flex: 1;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 50%, transparent);
  border-radius: 6px;
  padding: 0 7px;
  background: transparent;
  color: var(--color-text-main);
  outline: none;
}
.spatial-file-action {
  flex: 0 0 auto;
  color: var(--color-text-secondary);
  font-size: 11px;
}
.spatial-file-action:hover {
  color: var(--color-primary);
}
.spatial-file-delete {
  color: var(--color-text-secondary);
}
.spatial-file-delete:hover {
  color: var(--state-danger);
}
.spatial-empty {
  padding: 24px;
  border: 1px dashed color-mix(in srgb, var(--color-text-main) 16%, transparent);
  border-radius: 8px;
  color: var(--color-text-secondary);
  text-align: center;
  font-size: 12px;
}
.file-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
  margin-bottom: 14px;
  border-bottom: 1px solid var(--control-border);
}
.file-tab {
  display: flex;
  min-width: 0;
  height: 36px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 0 2px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
  cursor: pointer;
}
.file-tab:hover,
.file-tab[data-state='active'] {
  color: var(--color-primary);
}
.file-tab[data-state='active'] {
  border-bottom-color: var(--color-primary);
}
.file-tab small {
  font-size: 10px;
  font-weight: 500;
  opacity: 0.7;
}
.file-tab:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
  border-radius: 4px;
}
.file-download-hint {
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.engine-card-list {
  display: flex;
  max-height: 480px;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  padding: 2px 4px 2px 2px;
}

.engine-card {
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--color-text-main) 11%, transparent);
  border-radius: 12px;
  background: var(--control-muted-bg);
  transition:
    border-color 0.16s ease,
    background-color 0.16s ease;
}

.engine-card.is-active {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, var(--color-bg-elevated));
}

.engine-card-header,
.engine-name-row,
.engine-card-footer {
  display: flex;
  align-items: center;
}

.engine-card-header,
.engine-card-footer {
  justify-content: space-between;
  gap: 12px;
}

.engine-identity {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 3px;
}

.engine-name-row {
  min-width: 0;
  gap: 8px;
}

.engine-name-row strong {
  overflow: hidden;
  color: var(--color-text-main);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-active-badge {
  flex: 0 0 auto;
  padding: 2px 7px;
  border-radius: 9999px;
  background: var(--color-primary);
  color: white;
  font-size: 9px;
  font-weight: 700;
}

.engine-technical-info,
.engine-file-name {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 10px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-delete {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
}

.engine-delete:hover {
  background: color-mix(in srgb, var(--state-danger) 10%, transparent);
}

.engine-description {
  margin: 10px 0 0;
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 1.5;
}

.engine-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
}

.engine-capability {
  max-width: 100%;
  overflow: hidden;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--color-primary) 20%, var(--control-border));
  border-radius: 9999px;
  background: color-mix(in srgb, var(--color-primary) 5%, var(--color-bg-elevated));
  color: var(--color-text-secondary);
  font-size: 9px;
  font-weight: 650;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.engine-card-footer {
  margin-top: 13px;
  padding-top: 11px;
  border-top: 1px solid color-mix(in srgb, var(--color-text-main) 8%, transparent);
}

.engine-file-name {
  min-width: 0;
  flex: 1;
}
</style>
