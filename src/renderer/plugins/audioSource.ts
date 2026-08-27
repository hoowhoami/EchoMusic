import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue } from '@/types';
import type { PlaybackSource, ResolvedAudioSource } from '@/stores/player/types';

/** 保持旧插件的基础解析上下文兼容。 */
export interface PluginAudioSourceResolveContext {
  track: Song;
  quality: AudioQualityValue;
  effect: AudioEffectValue;
  forceReload: boolean;
}

export type PluginAudioSourcePosition = 'before-catalog' | 'after-catalog' | 'final-fallback';

export type PluginAudioSourceTransformStage = PluginAudioSourcePosition | 'catalog' | 'cloud';

export interface PluginAudioSourceStageResolveContext extends PluginAudioSourceResolveContext {
  position: PluginAudioSourcePosition;
}

export interface PluginAudioSourceTransformContext extends PluginAudioSourceResolveContext {
  /** 当前候选已经标准化；transform 可返回部分字段覆盖它。 */
  source: Readonly<ResolvedAudioSource>;
  /** 候选由哪一级解析产生，便于 transform 精确筛选。 */
  stage: PluginAudioSourceTransformStage;
}

export type PluginAudioSourceResolveResult =
  | string
  | Partial<ResolvedAudioSource>
  | null
  | undefined
  | false;

/**
 * null/undefined 表示保持当前候选，false 表示拒绝当前候选并继续播放器兜底链。
 * 字符串会替换候选 URL，对象则按字段合并到当前候选。
 */
export type PluginAudioSourceTransformResult = PluginAudioSourceResolveResult;

export interface PluginAudioSourceResolverContribution {
  id?: string;
  /** 同一阶段内按从小到大执行；resolve 与 transform 共用该顺序。 */
  order?: number;
  /** 仅控制 resolve 所在的兜底级别；旧插件默认保持 before-catalog 行为。 */
  position?: PluginAudioSourcePosition;
  match?: (context: PluginAudioSourceResolveContext) => boolean | Promise<boolean>;
  resolve?: (
    context: PluginAudioSourceStageResolveContext,
  ) => PluginAudioSourceResolveResult | Promise<PluginAudioSourceResolveResult>;
  /** transform 默认处理全部阶段，也可声明只处理指定来源阶段。 */
  transformStages?: PluginAudioSourceTransformStage | readonly PluginAudioSourceTransformStage[];
  /** 对指定阶段产生的每个有效候选依次执行，可替换、加工或拒绝候选。 */
  transform?: (
    context: PluginAudioSourceTransformContext,
  ) => PluginAudioSourceTransformResult | Promise<PluginAudioSourceTransformResult>;
}

interface RegisteredPluginAudioSourceResolver {
  pluginId: string;
  id: string;
  order: number;
  position: PluginAudioSourcePosition;
  match?: PluginAudioSourceResolverContribution['match'];
  resolve?: PluginAudioSourceResolverContribution['resolve'];
  transformStages: PluginAudioSourceTransformStage[];
  transform?: PluginAudioSourceResolverContribution['transform'];
  onError?: (source: string, error: unknown) => void;
}

const audioSourceResolvers: RegisteredPluginAudioSourceResolver[] = [];
const ALL_TRANSFORM_STAGES: PluginAudioSourceTransformStage[] = [
  'before-catalog',
  'catalog',
  'after-catalog',
  'cloud',
  'final-fallback',
];

const normalizeAudioQuality = (value: unknown): AudioQualityValue | null =>
  value === '128' ||
  value === '320' ||
  value === 'flac' ||
  value === 'high' ||
  value === 'viper_tape'
    ? value
    : null;

const normalizeAudioEffect = (value: unknown): AudioEffectValue => {
  const effects: AudioEffectValue[] = [
    'none',
    'piano',
    'vocal',
    'accompaniment',
    'subwoofer',
    'ancient',
    'surnay',
    'dj',
    'viper_atmos',
    'viper_clear',
  ];
  return effects.includes(value as AudioEffectValue) ? (value as AudioEffectValue) : 'none';
};

const normalizePlaybackSource = (
  value: unknown,
  fallbackAudioTrackId?: number | null,
): PlaybackSource | null => {
  const source =
    typeof value === 'string'
      ? { url: value, audioTrackId: fallbackAudioTrackId ?? null }
      : (value as Partial<PlaybackSource> | null | undefined);
  const url = String(source?.url || '').trim();
  if (!url) return null;
  const rawAudioTrackId =
    source?.audioTrackId !== undefined && source.audioTrackId !== null
      ? Number(source.audioTrackId)
      : (fallbackAudioTrackId ?? null);
  const audioTrackId = Number(rawAudioTrackId);
  return {
    url,
    audioTrackId: Number.isFinite(audioTrackId) && audioTrackId > 0 ? audioTrackId : null,
  };
};

const normalizeResolvedAudioSource = (
  result: PluginAudioSourceResolveResult,
): ResolvedAudioSource | null => {
  const value = typeof result === 'string' ? { url: result } : result;
  if (!value || typeof value !== 'object') return null;

  const audioTrackId =
    value.audioTrackId !== undefined && value.audioTrackId !== null
      ? Number(value.audioTrackId)
      : null;
  const rawSources = Array.isArray(value.sources) ? value.sources : [];
  const firstSourceFromList =
    rawSources
      .map((item) => normalizePlaybackSource(item, audioTrackId))
      .find((item): item is PlaybackSource => !!item) ?? null;
  const source =
    normalizePlaybackSource(value.source, audioTrackId) ??
    normalizePlaybackSource(value.url, audioTrackId) ??
    firstSourceFromList;
  if (!source) return null;

  const sources: PlaybackSource[] = [source];
  rawSources.forEach((item) => {
    const candidate = normalizePlaybackSource(item, source.audioTrackId);
    if (
      candidate &&
      !sources.some(
        (existing) =>
          existing.url === candidate.url && existing.audioTrackId === candidate.audioTrackId,
      )
    ) {
      sources.push(candidate);
    }
  });

  const urls = [source.url];
  if (Array.isArray(value.urls)) {
    value.urls.forEach((item) => {
      const candidate = String(item || '').trim();
      if (candidate && !urls.includes(candidate)) urls.push(candidate);
    });
  }
  sources.forEach((item) => {
    if (!urls.includes(item.url)) urls.push(item.url);
  });

  const loudness = value.loudness;
  const loudnessPeak = loudness && typeof loudness === 'object' ? loudness.peak : undefined;
  const normalizedLoudness: TrackLoudness | null =
    loudness && typeof loudness === 'object' && Number.isFinite(Number(loudness.lufs))
      ? {
          lufs: Number(loudness.lufs),
          gain: Number.isFinite(Number(loudness.gain)) ? Number(loudness.gain) : 0,
          peak:
            loudnessPeak === null || loudnessPeak === undefined
              ? null
              : Number.isFinite(Number(loudnessPeak))
                ? Number(loudnessPeak)
                : null,
        }
      : null;

  return {
    url: source.url,
    urls,
    audioTrackId: source.audioTrackId,
    source,
    sources,
    quality: normalizeAudioQuality(value.quality),
    effect: normalizeAudioEffect(value.effect),
    loudness: normalizedLoudness,
    sourceKind:
      value.sourceKind === 'catalog' ||
      value.sourceKind === 'cloud' ||
      value.sourceKind === 'plugin'
        ? value.sourceKind
        : undefined,
    noticeCode:
      typeof value.noticeCode === 'string' && value.noticeCode.trim()
        ? value.noticeCode.trim()
        : undefined,
  };
};

const hasOwn = (value: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(value, key);

const transformResolvedAudioSource = (
  current: ResolvedAudioSource,
  result: Exclude<PluginAudioSourceTransformResult, null | undefined | false>,
): ResolvedAudioSource | null => {
  if (typeof result === 'string') {
    return normalizeResolvedAudioSource({
      ...current,
      url: result,
      urls: [result],
      audioTrackId: null,
      source: { url: result },
      sources: [{ url: result }],
    });
  }

  const merged: Partial<ResolvedAudioSource> = { ...current, ...result };
  // 仅覆盖 url 时应真正替换旧候选，不能让 normalize 再优先取到旧 source。
  if (hasOwn(result, 'url')) {
    if (!hasOwn(result, 'audioTrackId')) merged.audioTrackId = null;
    if (!hasOwn(result, 'source')) merged.source = undefined;
    if (!hasOwn(result, 'sources')) merged.sources = undefined;
    if (!hasOwn(result, 'urls')) merged.urls = result.url ? [result.url] : [];
  }
  return normalizeResolvedAudioSource(merged);
};

const sortAudioSourceResolvers = () => {
  audioSourceResolvers.sort(
    (left, right) =>
      left.order - right.order ||
      left.pluginId.localeCompare(right.pluginId, 'zh-Hans-CN') ||
      left.id.localeCompare(right.id, 'zh-Hans-CN'),
  );
};

export const registerPluginAudioSourceResolver = (
  pluginId: string,
  contribution: PluginAudioSourceResolverContribution,
  onError?: (source: string, error: unknown) => void,
) => {
  const id = String(contribution.id || 'default').trim() || 'default';
  const key = `${pluginId}:${id}`;
  if (
    contribution.position !== undefined &&
    contribution.position !== 'before-catalog' &&
    contribution.position !== 'after-catalog' &&
    contribution.position !== 'final-fallback'
  ) {
    throw new Error(`不支持的音源解析位置: ${String(contribution.position)}`);
  }
  if (contribution.resolve !== undefined && typeof contribution.resolve !== 'function') {
    throw new Error('音源解析 resolve 必须是函数');
  }
  if (contribution.match !== undefined && typeof contribution.match !== 'function') {
    throw new Error('音源解析 match 必须是函数');
  }
  if (contribution.transform !== undefined && typeof contribution.transform !== 'function') {
    throw new Error('音源解析 transform 必须是函数');
  }
  if (!contribution.resolve && !contribution.transform) {
    throw new Error('音源解析至少需要提供 resolve 或 transform');
  }
  const transformStages = Array.isArray(contribution.transformStages)
    ? contribution.transformStages
    : contribution.transformStages
      ? [contribution.transformStages]
      : ALL_TRANSFORM_STAGES;
  if (transformStages.some((stage) => !ALL_TRANSFORM_STAGES.includes(stage))) {
    throw new Error(`不支持的音源转换阶段: ${String(contribution.transformStages)}`);
  }
  const rawOrder = Number(contribution.order ?? 1000);
  const existingIndex = audioSourceResolvers.findIndex(
    (item) => item.pluginId === pluginId && item.id === id,
  );
  if (existingIndex >= 0) audioSourceResolvers.splice(existingIndex, 1);

  audioSourceResolvers.push({
    pluginId,
    id,
    order: Number.isFinite(rawOrder) ? rawOrder : 1000,
    position: contribution.position ?? 'before-catalog',
    match: contribution.match,
    resolve: contribution.resolve,
    transformStages: [...new Set(transformStages)],
    transform: contribution.transform,
    onError,
  });
  sortAudioSourceResolvers();

  return () => {
    const index = audioSourceResolvers.findIndex((item) => `${item.pluginId}:${item.id}` === key);
    if (index >= 0) audioSourceResolvers.splice(index, 1);
  };
};

export const removeAudioSourceResolversByPlugin = (pluginId: string) => {
  for (let index = audioSourceResolvers.length - 1; index >= 0; index -= 1) {
    if (audioSourceResolvers[index].pluginId === pluginId) {
      audioSourceResolvers.splice(index, 1);
    }
  }
};

export const resolvePluginAudioSource = async (
  context: PluginAudioSourceResolveContext,
  position: PluginAudioSourcePosition = 'before-catalog',
): Promise<ResolvedAudioSource | null> => {
  for (const resolver of audioSourceResolvers.slice()) {
    if (resolver.position !== position || !resolver.resolve) continue;
    const source = `音源解析: ${resolver.id}`;
    try {
      const matched = resolver.match ? await resolver.match(context) : true;
      if (!matched) continue;

      const result = normalizeResolvedAudioSource(await resolver.resolve({ ...context, position }));
      if (!result) continue;
      const transformed = await transformPluginAudioSource(
        context,
        { ...result, sourceKind: result.sourceKind ?? 'plugin' },
        position,
      );
      // transform 可以拒绝某个插件候选；继续尝试同阶段的下一个解析器。
      if (transformed) return transformed;
    } catch (error) {
      resolver.onError?.(source, error);
    }
  }

  return null;
};

export const transformPluginAudioSource = async (
  context: PluginAudioSourceResolveContext,
  initialSource: ResolvedAudioSource,
  stage: PluginAudioSourceTransformStage,
): Promise<ResolvedAudioSource | null> => {
  let current = initialSource;
  for (const resolver of audioSourceResolvers.slice()) {
    if (!resolver.transform || !resolver.transformStages.includes(stage)) continue;
    const source = `音源转换: ${resolver.id}`;
    try {
      const matched = resolver.match ? await resolver.match(context) : true;
      if (!matched) continue;

      const result = await resolver.transform({ ...context, source: current, stage });
      if (result === false) return null;
      if (result === null || result === undefined) continue;
      const transformed = transformResolvedAudioSource(current, result);
      if (!transformed) {
        throw new Error('transform 返回了无效的音源');
      }
      current = transformed;
    } catch (error) {
      // 单个 transform 失败不应损坏已经可用的候选，也不阻断后续插件。
      resolver.onError?.(source, error);
    }
  }
  return current;
};
