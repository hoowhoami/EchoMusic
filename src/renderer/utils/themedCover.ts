import type { IconifyIcon } from '@iconify/types';
import { getAccentGradientPair } from './color';

export type ThemedIconCoverIcon = Pick<IconifyIcon, 'body'>;

export function createThemedIconCoverUrl(sourceColor: string, icon: ThemedIconCoverIcon) {
  const { from, to } = getAccentGradientPair(sourceColor);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${from}" />
          <stop offset="100%" stop-color="${to}" />
        </linearGradient>
      </defs>
      <rect width="400" height="400" rx="60" fill="url(#g)" />
      <circle cx="104" cy="96" r="52" fill="#FFFFFF" opacity="0.14" />
      <circle cx="308" cy="304" r="72" fill="#FFFFFF" opacity="0.10" />
      <g transform="translate(200 200)">
        <rect x="-92" y="-92" width="184" height="184" rx="46" fill="#FFFFFF" opacity="0.18" />
        <g transform="translate(-84 -84) scale(7)" color="#FFFFFF">
          ${icon.body}
        </g>
      </g>
    </svg>
  `;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
