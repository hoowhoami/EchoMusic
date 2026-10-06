import { LyricPlayer } from '@applemusic-like-lyrics/core';

/** Release animation effects before removing their lyric DOM. */
function releaseAnimations(element: HTMLElement) {
  for (const animation of element.getAnimations({ subtree: true })) {
    // cancel() alone leaves the KeyframeEffect and finish callback on the
    // Animation object. Drop their references to detached words immediately.
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    animation.effect = null;
  }
}

/** Own AMLL entry alignment and the lifetime of lyric animation resources. */
export class OpeningLyricPlayer extends LyricPlayer {
  private openingLayout = true;

  initializeViewport() {
    // Core starts at [0, 0] until ResizeObserver delivers. Its fallback line
    // height is viewportHeight / 5: at zero height every group lands at y=0
    // and is materialized as visible, defeating viewport culling on long songs.
    const element = this.getElement();
    this.size[0] = element.clientWidth;
    this.size[1] = element.clientHeight;
  }

  override calcLayout(sync = false, force = false): Promise<void> {
    // The base constructor may call this before the field initializer runs.
    // AMLL's sync flag removes stagger delays; only force bypasses its springs.
    return super.calcLayout(sync, force || this.openingLayout !== false);
  }

  override update(delta = 0): void {
    // Core's next update tears down these groups. Query animations only when a
    // mounted group leaves the viewport, never on every visible word/frame.
    for (const group of this.currentLyricGroups) {
      if (group.element.parentElement && !group.isInSight) {
        releaseAnimations(group.element);
      }
    }
    super.update(delta);
  }

  override setLyricLines(...args: Parameters<LyricPlayer['setLyricLines']>): void {
    // Interlude dots survive a lyric replacement; only discard old lyric words.
    for (const group of this.currentLyricGroups) releaseAnimations(group.element);
    super.setLyricLines(...args);
  }

  override dispose(): void {
    releaseAnimations(this.getElement());
    super.dispose();
    this.resizeObserver.disconnect();
    this.currentLyricGroups = [];
  }

  finishOpeningLayout() {
    this.openingLayout = false;
  }
}
