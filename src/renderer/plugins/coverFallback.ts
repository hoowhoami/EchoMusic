import { ref } from 'vue';
import { useThemeStore } from '@/stores/theme';

export const DEFAULT_COVER_URL = 'https://imge.kugou.com/soft/collection/default.jpg';

export type CoverFallbackReason = 'empty' | 'error';

export interface CoverFallbackContext {
  url: string;
  normalizedUrl: string;
  failedUrl?: string;
  size: number;
  reason: CoverFallbackReason;
  scope: string;
  alt?: string;
  /** 最终生效的主题色（已归一化的 hex），稳定值，不随主题过渡动画抖动 */
  accentColor: string;
  /** 最终主题色的 RGB 形式，格式 "r, g, b"，方便拼 rgba() */
  accentColorRgb: string;
}

export type CoverFallbackResolver = (context: CoverFallbackContext) => string | null | undefined;

export interface CoverFallbackContribution {
  pluginId: string;
  id: string;
  resolveUrl: CoverFallbackResolver;
}

export const coverFallbackRevision = ref(0);

let fallbackContribution: CoverFallbackContribution | null = null;

const normalizeContributionId = (id: string | undefined) =>
  String(id || 'default').trim() || 'default';

const updateFallbackContribution = (contribution: CoverFallbackContribution | null) => {
  fallbackContribution = contribution;
  coverFallbackRevision.value += 1;
};

const isSameContribution = (
  a: CoverFallbackContribution | null,
  b: CoverFallbackContribution | null,
) => a?.pluginId === b?.pluginId && a?.id === b?.id && a?.resolveUrl === b?.resolveUrl;

export const registerCoverFallbackResolver = (
  contribution: CoverFallbackContribution,
): (() => void) => {
  const item: CoverFallbackContribution = {
    ...contribution,
    id: normalizeContributionId(contribution.id),
  };

  // 去重：若与当前贡献完全一致（含 resolveUrl 引用），跳过更新，避免无意义的 revision 抖动
  // 否则任何插件每帧重复注册同一个 resolver 都会触发全局封面重算，引发列表封面闪烁
  if (!isSameContribution(fallbackContribution, item)) {
    updateFallbackContribution(item);
  }

  return () => {
    if (fallbackContribution?.pluginId !== item.pluginId || fallbackContribution.id !== item.id) {
      return;
    }
    updateFallbackContribution(null);
  };
};

export const removeCoverFallbackResolversByPlugin = (pluginId: string) => {
  if (fallbackContribution?.pluginId === pluginId) updateFallbackContribution(null);
};

export const resolveCoverFallbackUrl = (
  context: Omit<CoverFallbackContext, 'accentColor' | 'accentColorRgb'>,
): string => {
  void coverFallbackRevision.value;

  // 在此读取主题色 getter，使调用方（如 Cover.vue 的 computed）自动收集主题色依赖，
  // 主题色变化时无需插件 watch、也无需 revision 抖动即可驱动兜底封面重算。
  const theme = useThemeStore();
  const enrichedContext: CoverFallbackContext = {
    ...context,
    accentColor: theme.accentColor,
    accentColorRgb: theme.accentColorRgb,
  };

  const value = fallbackContribution?.resolveUrl(enrichedContext);
  if (typeof value === 'string' && value.trim()) return value.trim();

  return DEFAULT_COVER_URL;
};
