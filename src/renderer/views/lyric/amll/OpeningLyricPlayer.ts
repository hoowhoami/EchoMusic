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

  protected override buildLyricGroups(): void {
    super.buildLyricGroups();
    for (const group of this.currentLyricGroups) {
      const show = group.show.bind(group);
      group.show = () => {
        if (!group.element.parentElement) {
          // Core inserts the group, then builds/measures its words before
          // committing wrapper styles. Those reads flush the initial position
          // (or a stale culled position), starting a CSS transition from there.
          // Seed detached wrappers so their first layout is already aligned.
          const style = group.element.style;
          style.transform = `translateY(${group.posY.getCurrentPosition().toFixed(1)}px)`;
          style.opacity = String(group.opacity);
          const blur = Math.min(5, group.blur);
          style.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : 'none';
        }
        show();
      };
    }
  }

  setSecondaryVisibility(translation: boolean, romanization: boolean) {
    if (translation === this.showTranslation && romanization === this.showRomanization) return;
    this.showTranslation = translation;
    this.showRomanization = romanization;
    this.getElement().style.setProperty(
      '--echo-amll-roman-display',
      romanization ? 'flex' : 'none',
    );
    this.applySecondaryVisibility();
    this.secondaryLayoutIndex = this.timelineController.getSnapshot().scrollToIndex;
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

  override calcLayout(reason: Parameters<LyricPlayer['calcLayout']>[0]): void {
    // The base constructor may call this before the field initializer runs.
    // Revealed/cull-entering lines can report their new heights across several
    // ResizeObserver deliveries. Snap those resize layouts for the same hot line;
    // normal following and user scrolling still keep their springs.
    const secondaryLayout =
      this.secondaryLayoutIndex !== undefined &&
      this.secondaryLayoutIndex === this.timelineController?.getSnapshot().scrollToIndex;
    if (!secondaryLayout) this.secondaryLayoutIndex = undefined;
    // 0.6 uses layout reasons. Continuous scrolling snaps positions without
    // resetting the timeline, interlude or manual-scroll state.
    super.calcLayout(
      this.openingLayout !== false || (reason === 'resize' && secondaryLayout)
        ? 'continuous-scroll'
        : reason,
    );
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
