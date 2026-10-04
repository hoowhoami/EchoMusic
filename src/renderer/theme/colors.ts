import {
  contrast,
  mixColor,
  neutralTokens,
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

/** Keep the accent hue where possible, while pairing text with its actual surface. */
export function surfaceAccentText(accent: string, background: string, card: string): string {
  const backgrounds = [background, card];
  const score = (color: string) => Math.min(...backgrounds.map((bg) => contrast(color, bg)));
  if (score(accent) >= 4.5) return accent;
  const target = score('#ffffff') >= score('#000000') ? '#ffffff' : '#000000';
  let low = 0;
  let high = 1;
  for (let i = 0; i < 16; i++) {
    const amount = (low + high) / 2;
    if (score(mixColor(accent, target, amount)) >= 4.5) high = amount;
    else low = amount;
  }
  return mixColor(accent, target, high);
}

export function themeColorVariables(
  colors: ResolvedThemeColors,
  accent: string,
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
    '--text-secondary': tokens.secondary,
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
