import { ref } from 'vue';

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

export const registerCoverFallbackResolver = (
  contribution: CoverFallbackContribution,
): (() => void) => {
  const item: CoverFallbackContribution = {
    ...contribution,
    id: normalizeContributionId(contribution.id),
  };

  updateFallbackContribution(item);

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

export const resolveCoverFallbackUrl = (context: CoverFallbackContext): string => {
  coverFallbackRevision.value;

  const value = fallbackContribution?.resolveUrl(context);
  if (typeof value === 'string' && value.trim()) return value.trim();

  return DEFAULT_COVER_URL;
};
