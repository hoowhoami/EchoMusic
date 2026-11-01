import { computed, reactive, ref, toRaw, watch } from 'vue';
import { useSettingStore } from '@/stores/setting';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import { ensureEffectPlazaSync, plazaSyncState } from '@/utils/effectPlazaSync';
import { effectPlazaCacheState, plazaCacheRevision } from '@/stores/audioEffectPlazaCache';
import type { AudioEffectSupport } from '../../shared/audioEffectSupport';
import {
  getArtistAudioEffects,
  getAudioEffectBrands,
  getHeadphoneAudioEffects,
  getCommonHeadphoneAudioEffect,
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
export const useAudioEffectPlaza = () => {
  const settings = useSettingStore();
  const player = usePlayerStore();
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

  // 音效市场：列表/排序/搜索全部由本地持久化缓存派生，网络层只负责后台同步。
  // 依赖 revision 标量 + toRaw 快照读取：时长逐条回填（effectPlazaSync 每解析一条
  // 调用一次 setEffectDuration）不再逐条击穿全量 filter+sort，仅批量 bump 后重算一次。
  const sortCacheEntries = (sort: CommunityAudioEffectSort) => {
    void plazaCacheRevision.value;
    const effects = toRaw(effectPlazaCacheState).effects;
    return Object.values(effects)
      .filter((entry) => entry.ranks[sort] !== undefined)
      .sort((a, b) => (a.ranks[sort] ?? 0) - (b.ranks[sort] ?? 0));
  };

  const marketItems = computed<CommunityAudioEffect[]>(() => sortCacheEntries(marketSort.value));

  const searchQuery = ref('');
  const marketSearchResults = computed<CommunityAudioEffect[] | null>(() => {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return null;
    void plazaCacheRevision.value;
    const sort = marketSort.value;
    return (
      Object.values(toRaw(effectPlazaCacheState).effects)
        .filter((entry) =>
          [entry.name, entry.author, entry.tagName, ...entry.labels].some((value) =>
            value.toLowerCase().includes(query),
          ),
        )
        // 未同步到位次的条目排尾部，避免搜索结果顺序抖动。
        .sort(
          (a, b) =>
            (a.ranks[sort] ?? Number.MAX_SAFE_INTEGER) - (b.ranks[sort] ?? Number.MAX_SAFE_INTEGER),
        )
    );
  });
  // 搜索激活时列表内容替换为搜索结果。
  const marketList = computed(() => marketSearchResults.value ?? marketItems.value);
  const setSearch = (value: string) => {
    searchQuery.value = value;
  };
  const clearSearch = () => {
    searchQuery.value = '';
  };

  const formatDuration = (seconds: number) => {
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  };
  const effectDurationText = (effect: CommunityAudioEffect) => {
    // 与列表一致的 revision 依赖：时长回填后随批量失效刷新，而非订阅单条 entry
    void plazaCacheRevision.value;
    const cached = toRaw(effectPlazaCacheState).effects[String(effect.id)];
    return cached?.duration ? formatDuration(cached.duration) : '';
  };
  // 强制重新全量同步（刷新按钮）。
  const refreshMarket = () => {
    void ensureEffectPlazaSync(true);
  };

  const loadEffects = async (reset = false) => {
    if (isBrandDirectory.value) return;
    // 音效市场不走网络分页：列表由本地缓存派生，数据由后台同步器负责写入。
    if (category.value === 'market') return;
    if (!pages[pageKey.value]) pages[pageKey.value] = emptyPage<CommunityAudioEffect>();
    const state = pages[pageKey.value];
    if (state.loading) return;
    const nextPage = reset ? 1 : state.page + 1;
    // Capture the request's destination before awaiting. Late responses never overwrite another tab.
    const source = category.value;
    const brandId = selectedBrand.value?.id;
    state.loading = true;
    state.error = '';
    state.retryReset = reset;
    try {
      // 音效市场已在函数入口拦截，这里只剩歌手音效与耳机音效两条网络路径。
      const result =
        source === 'artist'
          ? await getArtistAudioEffects(nextPage, PAGE_SIZE)
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
    } else if (category.value === 'market') {
      // 打开音效市场即触发后台同步（幂等；缓存新鲜时仅补缺失时长）。
      void ensureEffectPlazaSync();
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
    settings.selectedImpulseResponseId === `community-effect-${effect.id}` &&
    !!downloadedEffect(effect) &&
    getEffectSupport(effect).status === 'supported';
  const getEffectSupport = (effect: CommunityAudioEffect): AudioEffectSupport => {
    const unsupported = (reason: string): AudioEffectSupport => ({ status: 'unsupported', reason });
    if (effect.unavailableReason) return unsupported(effect.unavailableReason);
    const downloaded = downloadedEffect(effect);
    const localSupport = downloaded && player.getSpatialAudioEffectSupport(downloaded);
    if (localSupport && localSupport.status !== 'supported') return localSupport;
    const ir = getCommunityImpulseResponseUrls(effect)[0];
    const vpf = getCommunityVpfUrls(effect)[0];
    if (effect.vpfUrls.length > 0 && !vpf) {
      return unsupported('音效参数资源无效，暂不支持使用');
    }
    if (downloaded && localSupport) {
      // A cached IR-only record is not a usable copy of an online IR + VPF effect.
      // Check all currently advertised resources, but do not require download URLs
      // to remain available for an otherwise complete, supported local file.
      if ((ir && !downloaded.impulseResponsePath) || (vpf && !downloaded.vpfPath))
        return unsupported('已下载的音效资源不完整，请删除后重新下载');
      return localSupport;
    }
    if (!ir && !vpf) return unsupported('暂无可下载的音效资源');
    return player.getSpatialAudioEffectSupport({
      id: `community-effect-${effect.id}`,
      name: effect.name,
      size: 0,
      importedAt: 0,
      kind: ir && vpf ? 'community-combined' : vpf ? 'community-vpf' : 'community-ir',
      // The downloader stores these canonical filenames regardless of URL suffix.
      impulseResponsePath: ir ? 'impulse-response.wav' : undefined,
      vpfPath: vpf ? 'effect.vpf' : undefined,
    });
  };
  const unavailableReason = (effect: CommunityAudioEffect) => getEffectSupport(effect).reason;
  const typeLabel = (effect: CommunityAudioEffect) => {
    const ir = getCommunityImpulseResponseUrls(effect).length > 0;
    const vpf = getCommunityVpfUrls(effect).length > 0;
    return ir && vpf ? '组合音效' : vpf ? 'VPF 音效' : ir ? '空间音效' : '暂无资源';
  };
  const applyEffect = (effect: CommunityAudioEffect) => {
    // Re-evaluate at click time, including actions retained in download toasts.
    const support = getEffectSupport(effect);
    if (support.status !== 'supported') {
      toast.warning(support.reason || '当前音效暂不可用');
      return false;
    }
    const downloaded = downloadedEffect(effect);
    if (!downloaded) {
      toast.warning('音效文件已移除，请重新下载');
      return false;
    }
    return player.selectSpatialAudioEffect(downloaded.id);
  };
  const actOnEffect = async (effect: CommunityAudioEffect) => {
    if (downloadingId.value !== null || isActive(effect)) return;
    const downloaded = downloadedEffect(effect);
    if (downloaded) {
      if (applyEffect(effect)) toast.success(`已使用“${effect.name}”`);
      return;
    }
    const support = getEffectSupport(effect);
    if (support.status !== 'supported') {
      toast.warning(support.reason || '当前音效暂不可用');
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
            applyEffect(effect);
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
    // 音效市场本地缓存派生状态。
    marketList,
    searchQuery,
    setSearch,
    clearSearch,
    plazaSyncState,
    refreshMarket,
    effectDurationText,
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
    getEffectSupport,
    unavailableReason,
    typeLabel,
    actOnEffect,
  });
};
export type AudioEffectPlazaState = ReturnType<typeof useAudioEffectPlaza>;
