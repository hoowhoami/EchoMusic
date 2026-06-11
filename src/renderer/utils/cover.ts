import {
  DEFAULT_COVER_URL,
  resolveCoverFallbackUrl,
  type CoverFallbackReason,
} from '@/plugins/coverFallback';

export { DEFAULT_COVER_URL };

export interface CoverDisplayOptions {
  reason?: CoverFallbackReason;
  scope?: string;
  alt?: string;
  failedUrl?: string;
}

export function normalizeCoverUrl(url: string | undefined, size: number = 400): string {
  const rawUrl = String(url ?? '').trim();
  if (!rawUrl) return '';

  let cover = rawUrl.replace('http://', 'https://');

  // 如果 URL 包含 {size} 占位符，替换为指定尺寸
  if (cover.includes('{size}')) {
    cover = cover.replace('{size}', size.toString());
  }
  // 如果 URL 不包含 {size}，保持原样，不添加尺寸参数
  // 因为很多图片服务器不支持通过查询参数调整尺寸

  // 替换旧域名
  return cover.replace('c1.kgimg.com', 'imge.kugou.com');
}

export function resolveCoverDisplayUrl(
  url: string | undefined,
  size: number = 400,
  options: CoverDisplayOptions = {},
): string {
  const normalizedUrl = normalizeCoverUrl(url, size);
  if (normalizedUrl && options.reason !== 'error') return normalizedUrl;

  const fallbackUrl = resolveCoverFallbackUrl({
    url: String(url ?? ''),
    normalizedUrl,
    failedUrl: options.failedUrl,
    size,
    reason: options.reason ?? (normalizedUrl ? 'error' : 'empty'),
    scope: options.scope ?? 'cover',
    alt: options.alt,
  });

  return normalizeCoverUrl(fallbackUrl, size) || DEFAULT_COVER_URL;
}

export function resolveCoverColorUrls(
  url: string | undefined,
  size: number = 300,
  options: Omit<CoverDisplayOptions, 'reason' | 'failedUrl'> = {},
): string[] {
  const normalizedUrl = normalizeCoverUrl(url, size);
  const fallbackUrl = resolveCoverDisplayUrl(url, size, {
    ...options,
    reason: normalizedUrl ? 'error' : 'empty',
    failedUrl: normalizedUrl,
  });
  return Array.from(new Set([normalizedUrl, fallbackUrl].filter(Boolean)));
}

export function getCoverUrl(url: string | undefined, size: number = 400): string {
  return normalizeCoverUrl(url, size) || DEFAULT_COVER_URL;
}
