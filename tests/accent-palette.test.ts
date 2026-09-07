import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getAccentPalette,
  createAccentPaletteFromPrimary,
  accentHex,
  normalizeAccent,
  parseAccent,
  contrastRatio,
  rgbToOklab,
  oklabToRgb,
  accentSurfaces,
} from '../src/shared/accent-palette.ts';

const colors = [
  '#000000',
  '#ffffff',
  '#777777',
  '#0071e3',
  '#ff0000',
  '#00ff00',
  '#0000ff',
  '#ffff00',
  '#ff00ff',
  '#00ffff',
  '#efece8',
  '#24182f',
];
for (let r = 0; r <= 255; r += 51)
  for (let g = 0; g <= 255; g += 51)
    for (let b = 0; b <= 255; b += 51)
      colors.push('#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''));

test('palette text and state foregrounds meet AA across saturated, neutral and gamut-edge seeds', () => {
  for (const dark of [false, true])
    for (const seed of colors) {
      const p = getAccentPalette(seed, dark);
      for (const bg of [...accentSurfaces(dark), p.subtle])
        assert.ok(
          contrastRatio(parseAccent(p.primaryText), parseAccent(bg)) >= 4.5,
          `${seed} / ${dark} / ${bg}`,
        );
      for (const [fg, bg] of [
        [p.onPrimary, p.primary],
        [p.onHover, p.hover],
        [p.onPressed, p.pressed],
        [p.onSubtle, p.subtle],
      ])
        assert.ok(contrastRatio(parseAccent(fg), parseAccent(bg)) >= 4.5, `${seed} ${fg} on ${bg}`);
    }
});
test('neutral user choices stay neutral and invalid inputs receive mode-aware fallback', () => {
  for (const dark of [false, true]) {
    for (const seed of ['#000', '#fff', '#888']) {
      const { r, g, b } = parseAccent(normalizeAccent(seed, dark));
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 1);
    }
    assert.equal(normalizeAccent('invalid', dark), normalizeAccent('#0071e3', dark));
  }
});
test('OKLab round trip preserves sRGB samples to one channel level', () => {
  for (const seed of colors) {
    const rgb = parseAccent(seed),
      result = oklabToRgb(rgbToOklab(rgb));
    for (const key of ['r', 'g', 'b'] as const)
      assert.ok(Math.abs(rgb[key] - result[key]) <= 1, seed);
  }
});
test('intermediate animation colors retain readable text and fill foregrounds', () => {
  for (const dark of [false, true]) {
    const from = rgbToOklab(parseAccent(normalizeAccent('#ff0000', dark)));
    const to = rgbToOklab(parseAccent(normalizeAccent('#0000ff', dark)));
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const rgb = oklabToRgb({
        l: from.l + (to.l - from.l) * t,
        a: from.a + (to.a - from.a) * t,
        b: from.b + (to.b - from.b) * t,
      });
      const p = createAccentPaletteFromPrimary(accentHex(rgb), dark);
      for (const bg of accentSurfaces(dark))
        assert.ok(contrastRatio(parseAccent(p.primaryText), parseAccent(bg)) >= 4.5);
      assert.ok(contrastRatio(parseAccent(p.onPrimary), rgb) >= 4.5);
    }
  }
});

test('atmosphere colors soften chroma without tinting neutral seeds', () => {
  for (const dark of [false, true])
    for (const seed of colors) {
      const palette = getAccentPalette(seed, dark);
      const accent = rgbToOklab(parseAccent(palette.primary));
      const tint = rgbToOklab(parseAccent(palette.atmosphere));
      assert.ok(
        Math.hypot(tint.a, tint.b) <=
          Math.min(0.067, Math.hypot(accent.a, accent.b) * 0.55 + 0.003),
      );
      assert.ok(Math.abs(tint.l - (dark ? 0.56 : 0.88)) < 0.004);
      if (Math.hypot(accent.a, accent.b) > 0.03) {
        const hueDifference = Math.atan2(tint.b, tint.a) - Math.atan2(accent.b, accent.a);
        assert.ok(Math.cos(hueDifference) > 0.995, seed);
      }
    }
});
