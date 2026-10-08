import type { ThemeOverride } from './model';

type Size = { width: number; height: number };

/** Match the artwork's CSS sizing, including its one-pixel edge bleed. */
export function customBackgroundImageGeometry(
  viewport: Size,
  image: Size,
  background: ThemeOverride['background'],
) {
  const width = (viewport.width * background.zoom) / 100 + 2;
  const height = (viewport.height * background.zoom) / 100 + 2;
  const ratios = [width / image.width, height / image.height];
  const scale = background.fit === 'cover' ? Math.max(...ratios) : Math.min(...ratios);
  const travelX = image.width * scale - viewport.width - 2;
  const travelY = image.height * scale - viewport.height - 2;
  return {
    width: image.width * scale,
    height: image.height * scale,
    left: -1 - (travelX * background.positionX) / 100,
    top: -1 - (travelY * background.positionY) / 100,
    travelX,
    travelY,
  };
}

/** Pan the enlarged artwork, rather than relying on cover's possibly zero crop area. */
export function customBackgroundImageStyle(image: string, background: ThemeOverride['background']) {
  const overflow = background.zoom - 100;
  return {
    backgroundImage: `url(${JSON.stringify(image)})`,
    backgroundSize: background.fit,
    backgroundPosition: `${background.positionX}% ${background.positionY}%`,
    // One pixel of bleed keeps fractional viewport edges covered at either endpoint.
    width: `calc(${background.zoom}% + 2px)`,
    height: `calc(${background.zoom}% + 2px)`,
    left: `calc(${(-overflow * background.positionX) / 100}% - 1px)`,
    top: `calc(${(-overflow * background.positionY) / 100}% - 1px)`,
  };
}
