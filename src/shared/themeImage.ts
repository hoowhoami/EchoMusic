export const MAX_THEME_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_THEME_IMAGE_PIXELS = 100_000_000;
export const MAX_THEME_IMAGE_EDGE = 2560;
// A 2560-square RGBA PNG can exceed the original compressed file's size.
export const MAX_THEME_IMAGE_PNG_BYTES = 32 * 1024 * 1024;
export type ThemeImageImportResult =
  { ok: true; id: string; url: string } | { ok: false; error: string };
