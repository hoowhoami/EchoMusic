/** Read at the time of interaction so system preference changes apply immediately. */
export function resolveScrollBehavior(behavior: ScrollBehavior = 'auto'): ScrollBehavior {
  if (
    behavior === 'smooth' &&
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  ) {
    // `auto` can still animate when the target has CSS scroll-behavior: smooth.
    return 'instant';
  }
  return behavior;
}
