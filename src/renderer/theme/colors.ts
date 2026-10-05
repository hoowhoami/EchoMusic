import {
  contrast,
  mixColor,
  neutralTokens,
  PANEL_MATERIAL,
  type AppThemeAppearance,
  type FloatingThemeColors,
  type ThemeTokens,
} from './model';

/** Foreground polarity belongs to the resolved palette, not the OS preference. */
export const usesLightForeground = (color: string) =>
  contrast(color, '#000000') >= contrast(color, '#ffffff');

const readableText = (preferred: string, background: string) => {
  if (contrast(preferred, background) >= 4.5) return preferred;
  return contrast('#ffffff', background) >= contrast('#000000', background) ? '#ffffff' : '#000000';
};

export interface ResolvedThemeColors {
  tokens: ThemeTokens;
  dark: boolean;
  tone: string;
  floating: FloatingThemeColors;
  floatingTone: string;
}

/** All theme providers enter through this resolver; no theme IDs or CSS selectors here. */
export function resolveThemeColors(
  appearance: AppThemeAppearance,
  requestedDark: boolean,
): ResolvedThemeColors {
  const input = appearance.tokens;
  const text = input.text ?? neutralTokens(requestedDark).text;
  const dark = usesLightForeground(text);
  const neutral = neutralTokens(dark);
  const tone = dark ? '#ffffff' : '#000000';
  const shell = appearance.background?.color ?? input.shell ?? neutral.shell;
  const main = input.main ?? shell;
  const tokens: ThemeTokens = {
    shell,
    sidebar: shell,
    main,
    // The player is part of the same panel system; it has no independent palette.
    player: main,
    card: input.card ?? mixColor(main, tone, 0.06),
    elevated: input.elevated ?? neutral.elevated,
    text,
    secondary: input.secondary ?? mixColor(text, main, 0.25),
    border: input.border ?? mixColor(main, text, 0.18),
  };
  const specified = appearance.floating;
  const background = specified?.background ?? tokens.elevated;
  const floatingText = readableText(specified?.text ?? neutral.text, background);
  const floatingTone = usesLightForeground(floatingText) ? '#ffffff' : '#000000';
  const cardCandidate = specified?.card ?? mixColor(background, floatingTone, 0.06);
  const card = contrast(floatingText, cardCandidate) >= 4.5 ? cardCandidate : background;
  const secondaryCandidate = specified?.secondary ?? mixColor(floatingText, background, 0.25);
  const secondary = [background, card].every((bg) => contrast(secondaryCandidate, bg) >= 4.5)
    ? secondaryCandidate
    : floatingText;
  const floating = {
    background,
    card,
    text: floatingText,
    secondary,
    border: specified?.border ?? mixColor(background, floatingText, 0.2),
  };
  tokens.elevated = background;
  return { tokens, dark, tone, floating, floatingTone };
}

/** Surfaces beneath content, including the single global cover tint and neutral controls. */
export function themeContentSurfaces(
  colors: ResolvedThemeColors,
  atmosphere?: { color: string; opacity: number },
): string[] {
  const { tokens, tone } = colors;
  const panel = mixColor(tokens.shell, tokens.main, PANEL_MATERIAL.opacity / 100);
  const bases = [panel, tokens.shell];
  if (atmosphere)
    bases.push(...bases.map((base) => mixColor(base, atmosphere.color, atmosphere.opacity)));
  return bases.flatMap((base) => [base, mixColor(base, tone, 0.1)]);
}

/** Keep the preferred color where readable, otherwise adjust towards its foreground. */
function readableSurfaceText(preferred: string, backgrounds: string[], target?: string): string {
  const score = (color: string) => Math.min(...backgrounds.map((bg) => contrast(color, bg)));
  if (score(preferred) >= 4.5) return preferred;
  const foreground = target ?? (score('#ffffff') >= score('#000000') ? '#ffffff' : '#000000');
  // Honor deliberately chosen image/plugin foregrounds when the artwork cannot be measured.
  if (score(foreground) < 4.5) return preferred;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 16; i++) {
    const amount = (low + high) / 2;
    if (score(mixColor(preferred, foreground, amount)) >= 4.5) high = amount;
    else low = amount;
  }
  return mixColor(preferred, foreground, high);
}

export function surfaceAccentText(accent: string, background: string, card: string): string {
  return readableSurfaceText(accent, [background, card]);
}

/** The immersive player has a dark cover backdrop even when the app is light.
 * Keep host chrome local while floating panels retain their own readable palette. */
export function lyricPageColorVariables(
  accent: string,
  background: string,
): Record<string, string> {
  const tokens = neutralTokens(true);
  const surfaces = [background, mixColor(background, tokens.text, 0.1)];
  return {
    '--text-main': tokens.text,
    '--text-secondary': readableSurfaceText(tokens.secondary, surfaces, tokens.text),
    '--content-tone': tokens.text,
    '--border-light': tokens.border,
    '--color-primary-text': readableSurfaceText(accent, surfaces),
    '--control-thumb-bg': tokens.text,
    '--window-action-color': 'var(--icon-main)',
    '--window-action-hover-color': 'var(--color-primary-text)',
  };
}

export function themeColorVariables(
  colors: ResolvedThemeColors,
  accent: string,
  surfaces: string[] = themeContentSurfaces(colors),
): Record<string, string> {
  const { tokens, floating } = colors;
  return {
    '--theme-shell': tokens.shell,
    '--surface-sidebar-base': tokens.sidebar,
    '--surface-main-base': tokens.main,
    '--surface-player-base': tokens.player,
    '--surface-card-base': tokens.card,
    '--surface-elevated-base': floating.background,
    '--surface-dialog-base': floating.background,
    '--text-main': tokens.text,
    '--text-secondary': readableSurfaceText(tokens.secondary, surfaces, tokens.text),
    '--border-light': tokens.border,
    '--content-tone': colors.tone,
    '--floating-text-main': floating.text,
    '--floating-text-secondary': floating.secondary,
    '--floating-card-base': floating.card,
    '--floating-border': floating.border,
    '--floating-tone': colors.floatingTone,
    '--floating-accent-text': surfaceAccentText(accent, floating.background, floating.card),
  };
}

/** Small independent windows share the readable floating surface, without shell artwork. */
export function independentWindowColorVariables(
  colors: Record<string, string>,
): Record<string, string> {
  const variables = { ...colors };
  const roles = {
    '--text-main': '--floating-text-main',
    '--text-secondary': '--floating-text-secondary',
    '--content-tone': '--floating-tone',
    '--border-light': '--floating-border',
    '--surface-card-base': '--floating-card-base',
    '--control-thumb-bg': '--floating-text-main',
  };
  for (const [role, source] of Object.entries(roles)) {
    if (colors[source]) variables[role] = colors[source];
  }
  return variables;
}
