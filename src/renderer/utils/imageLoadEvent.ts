/** A detached image or an event queued before a src update cannot settle the new resource. */
export function isCurrentImageEvent(
  event: Event,
  image: HTMLImageElement | null,
  source: string,
): boolean {
  return Boolean(
    source && image && event.currentTarget === image && image.getAttribute('src') === source,
  );
}
