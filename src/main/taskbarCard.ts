import type { NowPlayingPlaybackPayload } from '../shared/nowPlaying';

export const CARD_WIDTH = 511;
export const CARD_HEIGHT = 85;

const text = (value: string, limit: number) => {
  const chars = Array.from(value.trim());
  const clipped = chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
  return clipped
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
};

export function cardProgressPixel(playback: NowPlayingPlaybackPayload | null): number {
  const duration = playback?.duration ?? 0;
  const time = playback?.currentTime ?? 0;
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.round((CARD_WIDTH - 16) * Math.min(1, Math.max(0, time / duration)));
}

/** The accepted hover-card appearance, separate from the independent taskbar strip. */
export function buildTaskbarCardSvg(
  playback: NowPlayingPlaybackPayload | null,
  coverPng?: Buffer,
): string {
  const coverUrl = coverPng?.length ? `data:image/png;base64,${coverPng.toString('base64')}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c8f0cf"/><stop offset="1" stop-color="#e6f8e8"/></linearGradient>
      <clipPath id="coverClip"><rect x="24" y="8" width="42" height="42" rx="5"/></clipPath>
    </defs>
    <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="12" fill="url(#bg)"/>
    <rect x="8" y="8" width="2" height="69" rx="1" fill="#5bb879" opacity=".72"/>
    <rect x="24" y="8" width="42" height="42" rx="5" fill="#a3d5af"/>
    ${coverUrl ? `<image x="24" y="8" width="42" height="42" preserveAspectRatio="xMidYMid slice" clip-path="url(#coverClip)" xlink:href="${coverUrl}"/>` : ''}
    <text x="78" y="25" fill="#2b5a3a" font-family="Microsoft YaHei,Segoe UI,sans-serif" font-size="13" font-weight="600">${text(playback?.artist || 'EchoMusic', 22)}</text>
    <text x="78" y="45" fill="#143c25" font-family="Microsoft YaHei,Segoe UI,sans-serif" font-size="15" font-weight="700">${text(playback?.title || '未在播放', 25)}</text>
    <rect x="8" y="78" width="${CARD_WIDTH - 16}" height="2" rx="1" fill="#9bceaa" opacity=".55"/>
    <rect x="8" y="78" width="${cardProgressPixel(playback)}" height="2" rx="1" fill="#39a765"/>
  </svg>`;
}

export async function renderTaskbarCard(
  playback: NowPlayingPlaybackPayload | null,
  coverPng?: Buffer,
): Promise<Buffer> {
  // SVG is NOT a nativeImage format. Rasterize off the main thread first.
  // Lazy import lets the caller fall back to cover-only if the renderer is unavailable.
  const { renderAsync } = await import('@resvg/resvg-js');
  return (
    await renderAsync(buildTaskbarCardSvg(playback, coverPng), {
      font: { loadSystemFonts: true, defaultFontFamily: 'Microsoft YaHei' },
    })
  ).asPng();
}
