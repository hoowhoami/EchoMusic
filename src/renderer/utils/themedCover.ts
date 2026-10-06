import type { IconifyIcon } from '@iconify/types';
import { getAccentGradientPair } from './color';

export type ThemedIconCoverIcon = Pick<IconifyIcon, 'body'>;

// Keep the artwork full-bleed; Cover (or the plugin's image frame) owns corner clipping.
function createThemedCoverUrl(sourceColor: string, content: string) {
  const { from, to } = getAccentGradientPair(sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}" />
          <stop offset="100%" stop-color="${to}" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" fill="url(#g)" />
      <circle cx="104" cy="96" r="52" fill="#FFFFFF" opacity="0.14" />
      <circle cx="308" cy="304" r="72" fill="#FFFFFF" opacity="0.10" />
      <g transform="translate(200 200)">
        <rect x="-92" y="-92" width="184" height="184" rx="46" fill="#FFFFFF" opacity="0.18" />
        ${content}
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function createThemedIconCoverUrl(sourceColor: string, icon: ThemedIconCoverIcon) {
  return createThemedCoverUrl(
    sourceColor,
    `<g transform="translate(-84 -84) scale(7)" color="#FFFFFF">${icon.body}</g>`,
  );
}

export function createThemedDateCoverUrl(sourceColor: string, day: number) {
  const dayText = day.toString();
  const fontSize = dayText.length > 1 ? 132 : 150;
  return createThemedCoverUrl(
    sourceColor,
    `<text x="0" y="10" text-anchor="middle" dominant-baseline="middle" fill="#FFFFFF" opacity="0.94" font-size="${fontSize}" font-weight="800" font-family="SF Pro Display, PingFang SC, Arial" letter-spacing="0">${dayText}</text>`,
  );
}
