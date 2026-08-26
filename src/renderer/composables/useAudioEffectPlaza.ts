import { computed, reactive, ref, watch, type Ref } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import {
  getArtistAudioEffects,
  getAudioEffectBrands,
  getHeadphoneAudioEffects,
  getCommonHeadphoneAudioEffect,
  getCommunityAudioEffects,
  getCommunityImpulseResponseUrls,
  getCommunityVpfUrls,
  type AudioEffectBrand,
  type CommunityAudioEffect,
  type CommunityAudioEffectSort,
} from '@/api/audioEffect';

export type EffectPlazaCategory = 'artist' | 'headphone' | 'market';
interface PageState<T> {
  items: T[];
  page: number;
  total: number;
  loading: boolean;
  loaded: boolean;
  hasMore: boolean;
  error: string;
  retryReset: boolean;
}
const emptyPage = <T>(): PageState<T> => ({
  items: [],
  page: 0,
  total: 0,
  loading: false,
  loaded: false,
  hasMore: false,
  error: '',
  retryReset: false,
});
const PAGE_SIZE = 20;

// 生命周期属于播放器弹窗，而非单个分类面板；收起弹窗不会丢失下载状态和分页缓存。
export const useAudioEffectPlaza = (vpfSupport: Ref<'supported' | 'unsupported' | 'unknown'>) => {
  const settings = useSettingStore();
  const toast = useToastStore();
  const category = ref<EffectPlazaCategory>('artist');
  const selectedBrand = ref<AudioEffectBrand | null>(null);
  const marketSort = ref<CommunityAudioEffectSort>(2);
  const pages = reactive<Record<string, PageState<CommunityAudioEffect>>>({});
  const brands = reactive(emptyPage<AudioEffectBrand>());
  const common = reactive({
    effect: null as CommunityAudioEffect | null,
    loading: false,
    loaded: false,
    error: '',
  });
  const downloadingId = ref<number | null>(null);
  let activated = false;
  const isBrandDirectory = computed(() => category.value === 'headphone' && !selectedBrand.value);
  const pageKey = computed(() =>
    category.value === 'headphone'
      ? `headphone:${selectedBrand.value?.id ?? 0}`
      : category.value === 'market'
        ? `market:${marketSort.value}`
        : 'artist',
  );
  const currentPage = computed(() => pages[pageKey.value] ?? emptyPage<CommunityAudioEffect>());

  const loadEffects = async (reset = false) => {
    if (isBrandDirectory.value) return;
    if (!pages[pageKey.value]) pages[pageKey.value] = emptyPage<CommunityAudioEffect>();
    const state = pages[pageKey.value];
    if (state.loading) return;
    const nextPage = reset ? 1 : state.page + 1;
    // Capture the request's destination before awaiting. Late responses never overwrite another tab.
    const source = category.value;
    const brandId = selectedBrand.value?.id;
    const sort = marketSort.value;
    state.loading = true;
    state.error = '';
    state.retryReset = reset;
    try {
      const result =
        source === 'artist'
          ? await getArtistAudioEffects(nextPage, PAGE_SIZE)
          : source === 'market'
            ? await getCommunityAudioEffects(nextPage, PAGE_SIZE, sort)
            : await getHeadphoneAudioEffects(brandId!, nextPage, PAGE_SIZE);
      const items = reset ? [] : state.items;
      const seen = new Set(items.map((item) => item.id));
      state.items = [
        ...items,
        ...result.items.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        }),
      ];
      state.page = result.page;
      state.total = result.total;
      state.loaded = true;
      state.hasMore = result.items.length > 0 && result.page * result.pageSize < result.total;
    } catch (error) {
      state.error = error instanceof Error ? error.message : '音效加载失败，请重试';
    } finally {
      state.loading = false;
    }
  };
  const loadBrands = async (reset = false) => {
    if (brands.loading) return;
    brands.loading = true;
    brands.error = '';
    brands.retryReset = reset;
    try {
      const result = await getAudioEffectBrands(reset ? 1 : brands.page + 1, 30);
      const items = reset ? [] : brands.items;
      const seen = new Set(items.map((item) => item.id));
      brands.items = [
        ...items,
        ...result.items.filter((item) => {
          if (seen.has(item.id)) return false;
          seen.add(item.id);
          return true;
        }),
      ];
      brands.page = result.page;
      brands.total = result.total;
      brands.loaded = true;
      brands.hasMore = result.items.length > 0 && result.page * result.pageSize < result.total;
    } catch (error) {
      brands.error = error instanceof Error ? error.message : '耳机品牌加载失败';
    } finally {
      brands.loading = false;
    }
  };
  const loadCommon = async () => {
    if (common.loading) return;
    common.loading = true;
    common.error = '';
    try {
      common.effect = await getCommonHeadphoneAudioEffect();
      common.loaded = true;
    } catch (error) {
      common.error = error instanceof Error ? error.message : '通用耳机音效加载失败';
    } finally {
      common.loading = false;
    }
  };
  const ensureLoaded = () => {
    activated = true;
    if (isBrandDirectory.value) {
      if (!brands.loaded && !brands.error) void loadBrands(true);
      if (!common.loaded && !common.error) void loadCommon();
    } else if (!currentPage.value.loaded && !currentPage.value.error) {
      void loadEffects(true);
    }
  };
  watch(pageKey, () => {
    if (activated) ensureLoaded();
  });

  const downloadedEffect = (effect: CommunityAudioEffect) =>
    settings.impulseResponseFiles.find((file) => file.id === `community-effect-${effect.id}`);
  const isActive = (effect: CommunityAudioEffect) =>
    settings.impulseResponseEnabled &&
    settings.selectedImpulseResponseId === `community-effect-${effect.id}`;
  const unavailableReason = (effect: CommunityAudioEffect) => {
    const downloaded = downloadedEffect(effect);
    if (!downloaded && effect.unavailableReason) return effect.unavailableReason;
    if (!downloaded && effect.vpfUrls.length > 0 && !getCommunityVpfUrls(effect).length) {
      return '音效参数资源无效，暂不支持下载';
    }
    const needsVpf = downloaded ? !!downloaded.vpfPath : effect.vpfUrls.length > 0;
    if (needsVpf && vpfSupport.value !== 'supported')
      return '请先在设置 → 音效管理中启用支持 VPF 的音效引擎';
    if (
      !downloaded &&
      !getCommunityImpulseResponseUrls(effect).length &&
      !getCommunityVpfUrls(effect).length
    ) {
      return '暂无可下载的音效资源';
    }
    return '';
  };
  const typeLabel = (effect: CommunityAudioEffect) => {
    const ir = getCommunityImpulseResponseUrls(effect).length > 0;
    const vpf = getCommunityVpfUrls(effect).length > 0;
    return ir && vpf ? '组合音效' : vpf ? 'VPF 音效' : ir ? '卷积音效' : '暂无资源';
  };
  const applyEffect = (id: string) => settings.setSelectedImpulseResponse(id);
  const actOnEffect = async (effect: CommunityAudioEffect) => {
    if (downloadingId.value !== null || isActive(effect)) return;
    const reason = unavailableReason(effect);
    if (reason) {
      toast.warning(reason);
      return;
    }
    const downloaded = downloadedEffect(effect);
    if (downloaded) {
      applyEffect(downloaded.id);
      toast.success(`已使用“${effect.name}”`);
      return;
    }
    downloadingId.value = effect.id;
    try {
      const result = await window.electron.audioEffects.downloadCommunityAudioEffect({
        modelId: effect.id,
        name: effect.name,
        impulseResponseUrls: getCommunityImpulseResponseUrls(effect),
        vpfUrls: getCommunityVpfUrls(effect),
      });
      if (!result.file) throw new Error(result.error || '音效文件下载失败');
      const file = { ...result.file, source: effect.source };
      settings.addImpulseResponseFile(file, { select: false });
      toast.showAction(
        `已下载“${effect.name}”`,
        {
          label: '立即使用',
          handler: () => {
            const reason = unavailableReason(effect);
            if (reason) {
              toast.warning(reason);
              return;
            }
            applyEffect(file.id);
          },
        },
        'success',
        6000,
      );
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : '音效下载失败');
    } finally {
      downloadingId.value = null;
    }
  };
  return reactive({
    category,
    selectedBrand,
    marketSort,
    brands,
    common,
    currentPage,
    isBrandDirectory,
    pageKey,
    downloadingId,
    selectCategory: (value: EffectPlazaCategory) => {
      category.value = value;
    },
    selectSort: (value: CommunityAudioEffectSort) => {
      marketSort.value = value;
    },
    selectBrand: (value: AudioEffectBrand | null) => {
      selectedBrand.value = value;
    },
    ensureLoaded,
    loadEffects,
    loadBrands,
    loadCommon,
    downloadedEffect,
    isActive,
    unavailableReason,
    typeLabel,
    actOnEffect,
  });
};
export type AudioEffectPlazaState = ReturnType<typeof useAudioEffectPlaza>;
