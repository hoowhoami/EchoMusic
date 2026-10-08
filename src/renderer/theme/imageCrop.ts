import type { ThemeOverride, ThemeImageCrop } from './model';
import { customBackgroundImageGeometry } from './imageStyle';
export type ImageSize = { width: number; height: number };
export type CropCorner = 'nw' | 'ne' | 'se' | 'sw';
type Background = ThemeOverride['background'];
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const stageInset = 16;

/** Fit the stage to the photograph, leaving only space for the corner handles. */
export function backgroundCropStage(space: ImageSize, image: ImageSize): ImageSize {
  const inset = stageInset * 2;
  if (Math.min(space.width - inset, space.height - inset, image.width, image.height) <= 0)
    return { width: 0, height: 0 };
  const scale = Math.min(
    (space.width - inset) / image.width,
    (space.height - inset) / image.height,
  );
  return { width: image.width * scale + inset, height: image.height * scale + inset };
}

/** Keep the full original image stationary while moving a source-space selection. */
export function backgroundCropLayout(
  stage: ImageSize,
  viewport: ImageSize,
  image: ImageSize,
  background: Background,
) {
  if (
    Math.min(
      stage.width,
      stage.height,
      viewport.width,
      viewport.height,
      image.width,
      image.height,
    ) <= 0
  )
    return null;
  const scale = Math.max(
    0,
    Math.min(
      (stage.width - stageInset * 2) / image.width,
      (stage.height - stageInset * 2) / image.height,
    ),
  );
  if (!scale) return null;
  const artwork = {
    width: image.width * scale,
    height: image.height * scale,
    left: (stage.width - image.width * scale) / 2,
    top: (stage.height - image.height * scale) / 2,
  };
  let selection: ThemeImageCrop;
  if (background.crop) {
    const crop = background.crop;
    selection = {
      x: (crop.x * image.width) / crop.sourceWidth,
      y: (crop.y * image.height) / crop.sourceHeight,
      width: (crop.width * image.width) / crop.sourceWidth,
      height: (crop.height * image.height) / crop.sourceHeight,
      sourceWidth: image.width,
      sourceHeight: image.height,
    };
  } else {
    // Existing position/zoom settings still select the same region on first open.
    const rendered = customBackgroundImageGeometry(viewport, image, background);
    const renderedScale = rendered.width / image.width;
    const x = clamp(-rendered.left / renderedScale, 0, image.width - 1);
    const y = clamp(-rendered.top / renderedScale, 0, image.height - 1);
    selection = {
      x,
      y,
      width: Math.min(viewport.width / renderedScale, image.width - x),
      height: Math.min(viewport.height / renderedScale, image.height - y),
      sourceWidth: image.width,
      sourceHeight: image.height,
    };
  }
  return {
    artwork,
    scale,
    selection,
    crop: {
      width: selection.width * scale,
      height: selection.height * scale,
      left: artwork.left + selection.x * scale,
      top: artwork.top + selection.y * scale,
    },
  };
}
export type CropLayout = NonNullable<ReturnType<typeof backgroundCropLayout>>;

export function moveBackgroundCrop(layout: CropLayout, x: number, y: number): ThemeImageCrop {
  const crop = layout.selection;
  return {
    ...crop,
    x: clamp(crop.x + x / layout.scale, 0, crop.sourceWidth - crop.width),
    y: clamp(crop.y + y / layout.scale, 0, crop.sourceHeight - crop.height),
  };
}

/** Each edge moves independently; the opposite corner remains anchored. */
export function resizeBackgroundCrop(
  layout: CropLayout,
  corner: CropCorner,
  x: number,
  y: number,
): ThemeImageCrop {
  const crop = layout.selection;
  const minWidth = Math.min(crop.sourceWidth, 24 / layout.scale);
  const minHeight = Math.min(crop.sourceHeight, 24 / layout.scale);
  let left = crop.x,
    right = crop.x + crop.width,
    top = crop.y,
    bottom = crop.y + crop.height;
  if (corner.endsWith('e'))
    right = clamp(
      right + x / layout.scale,
      left + Math.min(minWidth, crop.sourceWidth - left),
      crop.sourceWidth,
    );
  else left = clamp(left + x / layout.scale, 0, right - Math.min(minWidth, right));
  if (corner.startsWith('s'))
    bottom = clamp(
      bottom + y / layout.scale,
      top + Math.min(minHeight, crop.sourceHeight - top),
      crop.sourceHeight,
    );
  else top = clamp(top + y / layout.scale, 0, bottom - Math.min(minHeight, bottom));
  return { ...crop, x: left, y: top, width: right - left, height: bottom - top };
}
