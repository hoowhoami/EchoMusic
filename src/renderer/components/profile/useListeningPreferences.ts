import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  emptyPreferences,
  preferenceChanges,
  preferenceError,
  recommendationValidation,
  type PreferencePatch,
  type PreferenceValues,
} from '../../../shared/listeningPreferences';

interface PreferenceApi {
  read: () => Promise<PreferenceValues>;
  update: (patch: PreferencePatch) => Promise<unknown>;
}

export function useListeningPreferences(account: Ref<string>, api: PreferenceApi) {
  const baseline = ref(emptyPreferences());
  const draft = ref(emptyPreferences());
  const loaded = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref('');
  const changes = computed(() => preferenceChanges(baseline.value, draft.value));
  const dirty = computed(() => Object.keys(changes.value).length > 0);
  let generation = 0;
  onScopeDispose(() => {
    generation++;
  });

  watch(
    account,
    () => {
      generation++;
      baseline.value = emptyPreferences();
      draft.value = emptyPreferences();
      loaded.value = loading.value = saving.value = false;
      error.value = '';
    },
    { flush: 'sync' },
  );

  async function load() {
    if (!account.value || loading.value || saving.value || dirty.value) return;
    const version = ++generation;
    loading.value = true;
    error.value = '';
    try {
      const remote = await api.read();
      if (version !== generation) return;
      baseline.value = { ...remote };
      draft.value = { ...baseline.value };
      loaded.value = true;
    } catch (cause) {
      if (version === generation) error.value = preferenceError(cause, '偏好加载失败，请稍后重试');
    } finally {
      if (version === generation) loading.value = false;
    }
  }

  async function save(): Promise<boolean> {
    if (!account.value || !loaded.value || loading.value || saving.value || !dirty.value)
      return false;
    if ('song_lang' in changes.value) {
      const validation = recommendationValidation(draft.value);
      if (validation) {
        error.value = validation;
        return false;
      }
    }
    const version = ++generation;
    const patch = { ...changes.value };
    const submitted = { ...draft.value };
    saving.value = true;
    error.value = '';
    try {
      await api.update(patch);
      if (version !== generation) return false;
      baseline.value = submitted;
      draft.value = { ...submitted };
      return true;
    } catch (cause) {
      if (version === generation)
        error.value = preferenceError(cause, '保存失败，已保留你的选择，请重试');
      return false;
    } finally {
      if (version === generation) saving.value = false;
    }
  }

  function discard() {
    draft.value = { ...baseline.value };
    error.value = '';
  }
  return { draft, loaded, loading, saving, error, dirty, load, save, discard };
}
