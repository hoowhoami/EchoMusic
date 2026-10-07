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
  private showTranslation = true;
  private showRomanization = true;
  private secondaryLayoutIndex: number | undefined;

  setSecondaryVisibility(translation: boolean, romanization: boolean) {
    if (translation === this.showTranslation && romanization === this.showRomanization) return;
    this.showTranslation = translation;
    this.showRomanization = romanization;
    this.getElement().style.setProperty(
      '--echo-amll-roman-display',
      romanization ? 'flex' : 'none',
    );
    this.applySecondaryVisibility();
    this.secondaryLayoutIndex = this.timelineState.scrollToIndex;
  }

  private applySecondaryVisibility() {
    if (this.currentLyricGroups.length === 0) return;
    for (const group of this.currentLyricGroups) {
      for (const line of [group.mainLine, group.bgLine]) {
        if (!line) continue;
        // Core creates permanent main/translation/romanization containers, also
        // for culled lines. Preserve those elements and all word animations.
        const children = line.getElement().children;
        (children[1] as HTMLElement).style.display = this.showTranslation ? '' : 'none';
        (children[2] as HTMLElement).style.display = this.showRomanization ? '' : 'none';
      }
    }
  }

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
    // Revealed/cull-entering lines can report their new heights across several
    // ResizeObserver deliveries. Snap those sync layouts for the same hot line;
    // normal following and user scrolling still keep their springs.
    const secondaryLayout =
      this.secondaryLayoutIndex !== undefined &&
      this.secondaryLayoutIndex === this.timelineState?.scrollToIndex;
    if (!secondaryLayout) this.secondaryLayoutIndex = undefined;
    return super.calcLayout(
      sync,
      force || this.openingLayout !== false || (sync && secondaryLayout),
    );
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
    this.secondaryLayoutIndex = undefined;
    super.setLyricLines(...args);
    this.applySecondaryVisibility();
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
