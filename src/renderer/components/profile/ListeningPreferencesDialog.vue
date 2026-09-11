<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Select from '@/components/ui/Select.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import PreferenceStrengthSlider from './PreferenceStrengthSlider.vue';
import { iconCheck, iconChevronDown, iconRefreshCw, iconShield } from '@/icons';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { getListeningPreferences, updateListeningPreferences } from '@/api/listeningPreferences';
import {
  recommendationModes,
  recommendationOptions,
  recommendationStrength,
  resetRecommendationPreferences,
  setRecommendationStrength,
  preferenceChanges,
  preferenceGroups,
  preferenceGenderOptions,
  preferenceAgeOptions,
  preferenceWeights,
  togglePreference,
  type PreferenceOption,
} from '../../../shared/listeningPreferences';
import { useListeningPreferences } from './useListeningPreferences';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; blacklist: [] }>();
const userStore = useUserStore();
const toast = useToastStore();
const account = computed(() => (userStore.isLoggedIn ? String(userStore.info?.userid ?? '') : ''));
const { draft, loaded, loading, saving, error, dirty, load, save, discard } =
  useListeningPreferences(account, {
    read: getListeningPreferences,
    update: updateListeningPreferences,
  });
const confirmDiscard = ref(false);
const moreTab = ref(0);
const moreId = useId();
const moreTabs = ['语言', '风格', '关于你'];
const moreTabIds = moreTabs.map((_, index) => `${moreId}-tab-${index}`);
const morePanelIds = moreTabs.map((_, index) => `${moreId}-panel-${index}`);
const strengthEditable = computed(() => preferenceWeights(draft.value.song_lang) !== null);
const canReset = computed(
  () =>
    Object.keys(preferenceChanges(draft.value, resetRecommendationPreferences(draft.value)))
      .length > 0,
);
const selectedMode = computed(() => draft.value.mode || '0');
const modeLabels = recommendationModes.map((mode) => mode.label);
const selectedModeIndex = computed({
  get: () => recommendationModes.findIndex((mode) => mode.value === selectedMode.value),
  set: (index: number) => {
    const mode = recommendationModes[index];
    if (mode && !busy.value) draft.value.mode = mode.value;
  },
});

const modeDescription = computed(
  () =>
    recommendationModes.find((item) => item.value === selectedMode.value)?.description ||
    '当前为其他版本的推荐模式，可选择新的模式。',
);
const strength = (id: string) => recommendationStrength(draft.value.song_lang, id);
const updateStrength = (id: string, value: number) => {
  draft.value.song_lang = setRecommendationStrength(draft.value.song_lang, id, value);
};
const resetDefaults = () => {
  draft.value = resetRecommendationPreferences(draft.value);
  error.value = '';
};

const busy = computed(() => loading.value || saving.value);
const open = computed({
  get: () => props.open,
  set: (value: boolean) => {
    if (value || saving.value) return;
    if (dirty.value) confirmDiscard.value = true;
    else emit('update:open', false);
  },
});
const weights = computed(() => ({
  lang: preferenceWeights(draft.value.lang),
  style: preferenceWeights(draft.value.style),
}));
const withCurrentOption = (items: PreferenceOption[], value: string) =>
  items.some((item) => item.value === value)
    ? items
    : [...items, { value, label: '当前设置（其他版本）' }];
const genderOptions = computed(() =>
  withCurrentOption(preferenceGenderOptions, draft.value.gender),
);
const ageOptions = computed(() => withCurrentOption(preferenceAgeOptions, draft.value.age));
const unknownCount = (field: 'lang' | 'style') => {
  const group = preferenceGroups.find((item) => item.field === field)!;
  return Object.keys(weights.value[field] ?? {}).filter(
    (id) => !group.options.some((option) => option.value === id),
  ).length;
};
const selectedCount = (field: 'lang' | 'style') =>
  preferenceGroups
    .find((group) => group.field === field)!
    .options.filter((item) => (weights.value[field]?.[item.value] ?? 0) > 50).length;
const discardAndClose = () => {
  discard();
  confirmDiscard.value = false;
  emit('update:open', false);
};
const submit = async () => {
  if (await save()) toast.success('听歌偏好已保存');
};
watch(
  () => props.open,
  (value) => {
    if (value) void load();
    else confirmDiscard.value = false;
  },
  { immediate: true },
);
watch(account, () => {
  confirmDiscard.value = false;
  emit('update:open', false);
});
</script>

<template>
  <Dialog
    v-model:open="open"
    title="听歌偏好设置"
    contentClass="listening-preferences-dialog"
    :showClose="!saving"
    :closeOnEscape="!saving"
    :closeOnInteractOutside="!saving"
  >
    <template #headerActions>
      <Button
        variant="ghost"
        size="xs"
        class="preferences-refresh"
        :disabled="!loaded || busy || dirty"
        aria-label="刷新听歌偏好"
        tooltip="刷新听歌偏好"
        @click="load()"
      >
        <Icon :icon="iconRefreshCw" width="14" height="14" :class="{ 'animate-spin': loading }" />
      </Button>
    </template>
    <div class="preferences-body" :aria-busy="busy">
      <div v-if="error" class="preferences-error" role="alert">
        <span>{{ error }}</span
        ><Button v-if="!loaded" size="xs" variant="outline" :disabled="busy" @click="load()"
          >重新加载</Button
        >
      </div>
      <section class="preferences-card">
        <div class="preferences-card-heading">
          <h4>推荐偏好</h4>
          <Button
            variant="unstyled"
            size="none"
            type="button"
            class="preferences-blacklist-button"
            :disabled="saving"
            aria-label="打开黑名单管理"
            @click="emit('blacklist')"
          >
            <Icon :icon="iconShield" width="14" height="14" aria-hidden="true" />
            <span>黑名单</span>
          </Button>
        </div>
        <div v-if="!loaded && loading" class="preferences-state" role="status">
          <Icon :icon="iconRefreshCw" width="20" height="20" class="animate-spin" />
          <span>正在读取你的听歌偏好</span>
        </div>
        <template v-if="loaded">
          <CustomTabBar
            v-model="selectedModeIndex"
            :tabs="modeLabels"
            :disabled="busy"
            role="radiogroup"
            aria-label="推荐模式"
            class="mt-3.5"
          />
          <p class="preferences-hint preferences-mode-hint">{{ modeDescription }}</p>
        </template>
      </section>
      <template v-if="loaded">
        <section class="preferences-card">
          <h4>语种与内容偏好</h4>
          <p class="preferences-hint">拖动调整推荐强度，居中为默认，最左侧为屏蔽。</p>
          <div class="preferences-strengths">
            <PreferenceStrengthSlider
              v-for="option in recommendationOptions"
              :key="option.value"
              :label="option.label"
              :modelValue="strength(option.value)"
              :disabled="busy || !strengthEditable"
              @update:modelValue="updateStrength(option.value, $event)"
            />
          </div>
          <p v-if="!strengthEditable" class="preferences-hint">
            这组偏好暂时无法解析，已保留原值；其他偏好仍可编辑。
          </p>
        </section>
        <details class="preferences-card preferences-more">
          <summary>
            <span class="preferences-more-title">更多偏好<span>细化你的音乐口味</span></span>
            <Icon
              :icon="iconChevronDown"
              width="16"
              height="16"
              class="preferences-more-chevron"
              aria-hidden="true"
            />
          </summary>
          <div class="preferences-more-body">
            <CustomTabBar
              v-model="moreTab"
              :tabs="moreTabs"
              :tab-ids="moreTabIds"
              :panel-ids="morePanelIds"
              aria-label="更多偏好分类"
            />
            <div
              v-for="(group, index) in preferenceGroups"
              v-show="moreTab === index"
              :id="morePanelIds[index]"
              :key="group.field"
              role="tabpanel"
              :aria-labelledby="moreTabIds[index]"
              tabindex="0"
              class="preferences-more-panel"
            >
              <fieldset class="preferences-group" :disabled="busy || weights[group.field] === null">
                <legend>
                  {{ group.title }}
                  <span class="preferences-count">{{
                    selectedCount(group.field) ? `已选 ${selectedCount(group.field)} 项` : '可多选'
                  }}</span>
                </legend>
                <div class="preferences-tags">
                  <button
                    v-for="option in group.options"
                    :key="option.value"
                    type="button"
                    class="preference-tag"
                    :aria-pressed="(weights[group.field]?.[option.value] ?? 0) > 50"
                    @click="draft[group.field] = togglePreference(draft[group.field], option.value)"
                  >
                    <span>{{ option.label }}</span>
                    <Icon
                      :icon="iconCheck"
                      width="13"
                      height="13"
                      class="preference-check"
                      aria-hidden="true"
                    />
                  </button>
                </div>
                <p v-if="weights[group.field] === null" class="preferences-hint">
                  这组偏好暂时无法解析，已保留原值；其他偏好仍可编辑。
                </p>
                <p v-else-if="unknownCount(group.field)" class="preferences-hint">
                  另有 {{ unknownCount(group.field) }} 项来自其他版本的偏好，将一并保留。
                </p>
              </fieldset>
            </div>
            <div
              v-show="moreTab === 2"
              :id="morePanelIds[2]"
              role="tabpanel"
              :aria-labelledby="moreTabIds[2]"
              tabindex="0"
              class="preferences-more-panel"
            >
              <fieldset class="preferences-group" :disabled="busy">
                <legend>关于你 <span class="preferences-count">选填</span></legend>
                <p class="preferences-hint">仅用于推荐，不修改个人资料。</p>
                <div class="preferences-demographics">
                  <div>
                    <span class="preferences-label">性别偏好</span
                    ><Select
                      v-model="draft.gender"
                      :options="genderOptions"
                      :disabled="busy"
                      aria-label="性别偏好"
                    />
                  </div>
                  <div>
                    <span class="preferences-label">年龄段</span
                    ><Select
                      v-model="draft.age"
                      :options="ageOptions"
                      :disabled="busy"
                      aria-label="年龄段"
                    />
                  </div>
                </div>
              </fieldset>
            </div>
          </div>
        </details>
      </template>
    </div>
    <template #footer>
      <div class="preferences-footer">
        <div class="preferences-footer-actions">
          <Button
            variant="secondary"
            size="sm"
            :disabled="!loaded || busy || !canReset"
            @click="resetDefaults"
            >恢复默认</Button
          >
          <Button
            size="sm"
            :loading="saving"
            :disabled="!loaded || loading || !dirty"
            @click="submit"
            >保存偏好</Button
          >
        </div>
        <p>恢复默认仅重置推荐模式与强度，点击保存后生效。</p>
      </div>
    </template>
  </Dialog>
  <Dialog
    v-model:open="confirmDiscard"
    title="放弃未保存的偏好？"
    description="你的选择还没有保存，关闭后将丢弃本次修改。"
  >
    <template #footer>
      <Button variant="outline" size="sm" @click="confirmDiscard = false">继续编辑</Button>
      <Button size="sm" @click="discardAndClose">放弃修改</Button>
    </template>
  </Dialog>
</template>

<style scoped>
/* 独立于弹窗关闭操作，黑名单属于推荐管理。 */
.preferences-card-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.preferences-blacklist-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--control-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.preferences-blacklist-button:hover:not(:disabled) {
  background: var(--control-hover-bg);
  color: var(--color-text-main);
}
.preferences-body {
  display: grid;
  gap: 14px;
  padding-top: 12px;
}
.preferences-card {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--content-panel-border);
  border-radius: 18px;
  background: var(--content-panel-bg);
}
.preferences-card h4 {
  font-size: 13px;
  font-weight: 800;
}
.preferences-more summary:focus-visible,
.preferences-more-panel:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}
.preferences-mode-hint {
  margin-bottom: 0 !important;
  text-align: center;
}
.preferences-strengths {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.preferences-hint {
  margin: 6px 0 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-secondary);
}
.preferences-more summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  list-style: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 800;
}
.preferences-more summary::-webkit-details-marker {
  display: none;
}
.preferences-more-title {
  display: grid;
  gap: 4px;
}
.preferences-more-title > span {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.preferences-more-chevron {
  flex-shrink: 0;
  color: var(--color-text-secondary);
  transition: transform 0.2s ease;
}
.preferences-more[open] .preferences-more-chevron {
  transform: rotate(180deg);
}
.preferences-more-body {
  display: grid;
  gap: 20px;
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--content-panel-border);
}
.preferences-state {
  min-height: 108px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--color-text-secondary);
}
.preferences-group {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.preferences-group legend {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  font-weight: 800;
  width: 100%;
}
.preferences-count {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}
.preferences-tags {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
  margin-top: 14px;
}
.preference-tag {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--control-border);
  background: var(--control-muted-bg);
  border-radius: 11px;
  font-size: 12px;
  color: var(--color-text-main);
  font-weight: 500;
  min-height: 40px;
  cursor: pointer;
}
.preference-tag:hover:not(:disabled) {
  background: var(--control-hover-bg);
}
.preference-tag[aria-pressed='true'] {
  color: var(--color-primary-text);
  background: rgba(var(--color-primary-rgb), 0.12);
  border-color: rgba(var(--color-primary-rgb), 0.5);
}
.preference-tag:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 3px;
}
.preference-check {
  flex-shrink: 0;
  opacity: 0;
}
.preference-tag[aria-pressed='true'] .preference-check {
  opacity: 1;
}
.preference-tag:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.preferences-demographics {
  display: grid;
  gap: 8px;
}
.preferences-demographics > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 8px 12px;
  border: 1px solid var(--content-panel-border);
  border-radius: 12px;
}
.preferences-label {
  display: block;
  font-size: 12px;
  font-weight: 700;
}
.preferences-demographics :deep(.echo-select-trigger) {
  min-width: 120px;
  min-height: 40px;
}
.preferences-footer {
  width: 100%;
}
.preferences-footer-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.preferences-refresh {
  width: 32px;
  height: 32px;
  min-width: 0;
  padding: 0;
}
.preferences-footer p {
  margin-top: 10px;
  text-align: center;
  font-size: 10px;
  line-height: 1.5;
  color: var(--color-text-secondary);
}
.preferences-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px;
  border-radius: 12px;
  background: var(--control-muted-bg);
  font-size: 12px;
  line-height: 1.7;
}
@media (max-width: 520px) {
  .preferences-strengths,
  .preferences-demographics {
    grid-template-columns: 1fr;
  }
  .preferences-tags {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (prefers-reduced-motion: reduce) {
  .preferences-more-chevron {
    transition: none;
  }
}
@media (max-width: 400px) {
  .preferences-tags {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

<style>
.dialog-content.listening-preferences-dialog {
  width: min(640px, 92vw);
  max-height: min(860px, calc(100vh - 100px));
}
</style>
