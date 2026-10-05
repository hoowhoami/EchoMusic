import { onScopeDispose } from 'vue';

const SOURCE = '[data-player-cover]';
const TARGET = '[data-lyric-cover]';
const ENTER_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const LEAVE_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

interface Motion {
  host: HTMLElement;
  animations: Animation[];
  restore: (() => void)[];
  flight?: HTMLElement;
  clips?: [HTMLElement, HTMLElement];
  stopWaiting?: () => void;
}

interface InterruptedMotion {
  at: number;
  opacity: string;
  transform: string;
  cover: DOMRect | null;
  clipOpacities?: [string, string];
}

/** Animate artwork independently of the page so text and controls never stretch. */
export function useLyricPageTransition() {
  let active: Motion | undefined;
  let interrupted: InterruptedMotion | undefined;

  const capture = () => {
    if (!active) return;
    const style = getComputedStyle(active.host);
    const flight = active.flight;
    const bounds = flight?.getBoundingClientRect() ?? null;
    interrupted = {
      at: performance.now(),
      opacity: style.opacity,
      transform: style.transform,
      cover: bounds && bounds.width > 0 ? bounds : null,
      clipOpacities: active.clips?.map((clip) => getComputedStyle(clip).opacity) as
        | [string, string]
        | undefined,
    };
  };

  const cleanup = () => {
    const motion = active;
    active = undefined;
    if (!motion) return;
    motion.stopWaiting?.();
    motion.animations.forEach((animation) => animation.cancel());
    motion.flight?.remove();
    motion.restore.forEach((restore) => restore());
    motion.host.style.removeProperty('opacity');
    motion.host.removeAttribute('data-entering');
    motion.host.removeAttribute('data-motion');
  };

  const animate = (
    motion: Motion,
    element: HTMLElement,
    frames: Keyframe[],
    duration: number,
    entering: boolean,
    delay = 0,
  ) => {
    const animation = element.animate(frames, {
      duration,
      delay,
      easing: entering ? ENTER_EASE : LEAVE_EASE,
      fill: 'both',
    });
    motion.animations.push(animation);
  };

  const hide = (motion: Motion, element: HTMLElement) => {
    const opacity = element.style.getPropertyValue('opacity');
    const priority = element.style.getPropertyPriority('opacity');
    element.style.setProperty('opacity', '0', 'important');
    motion.restore.push(() => {
      if (opacity) element.style.setProperty('opacity', opacity, priority);
      else element.style.removeProperty('opacity');
    });
  };

  const rect = (element: HTMLElement | null) => {
    if (!element?.isConnected) return null;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 ? bounds : null;
  };

  // The host mounts before its async page/AMLL skin. Wait for real geometry,
  // without keeping a mutation observer or a frame loop alive after the entry.
  const waitForPage = (motion: Motion) =>
    new Promise<void>((resolve) => {
      let frame = 0;
      let timeout = 0;
      const finish = () => {
        observer?.disconnect();
        cancelAnimationFrame(frame);
        window.clearTimeout(timeout);
        motion.stopWaiting = undefined;
        resolve();
      };
      const ready = () => {
        const page = motion.host.querySelector<HTMLElement>('.lyric-page');
        return Boolean(
          page && (page.dataset.lyricTransition !== 'cover' || motion.host.querySelector(TARGET)),
        );
      };
      const check = () => {
        if (frame || !ready()) return;
        // Stop watching as soon as the async component exists. The next frame
        // lets Vue finish its DOM patch before the single geometry read phase.
        observer?.disconnect();
        frame = requestAnimationFrame(finish);
      };
      const observer = ready() ? undefined : new MutationObserver(check);
      motion.stopWaiting = finish;
      if (!observer) {
        check();
        return;
      }
      observer.observe(motion.host, { childList: true, subtree: true });
      timeout = window.setTimeout(finish, 800);
    });

  const run = async (el: Element, done: () => void, entering: boolean) => {
    capture();
    const previous =
      interrupted && performance.now() - interrupted.at < 100 ? interrupted : undefined;
    interrupted = undefined;
    cleanup();
    const host = el as HTMLElement;
    const motion: Motion = { host, animations: [], restore: [] };
    active = motion;
    if (entering) {
      host.removeAttribute('data-leaving');
      host.setAttribute('data-entering', '');
      host.style.opacity = '0';
      await waitForPage(motion);
      if (active !== motion) return;
    } else {
      host.setAttribute('data-leaving', '');
      if (!host.querySelector('.lyric-page')) {
        cleanup();
        done();
        return;
      }
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cleanup();
      done();
      return;
    }

    const source = document.querySelector<HTMLElement>(SOURCE);
    const target = host.querySelector<HTMLElement>(TARGET);
    const small = rect(source);
    const large = rect(target);
    const duration = entering ? 460 : 360;
    const hasCover = source && target && small && large;

    if (hasCover) {
      // Clone the already displayed image, including its placeholder on failure.
      // It remains visible while the large image loads and needs no network wait.
      const artwork = entering ? source : target;
      // Finish all layout/style reads before connecting the flight or hiding
      // either real cover. No geometry reads occur on a normal animation frame.
      const radius = getComputedStyle(target).borderTopLeftRadius;
      const smallRadius = parseFloat(getComputedStyle(source).borderTopLeftRadius) || 0;
      const background = getComputedStyle(artwork).backgroundColor;
      const scaleX = small.width / large.width;
      const scaleY = small.height / large.height;
      host.dataset.motion = 'cover';
      const flight = document.createElement('div');
      flight.className = 'lyric-cover-flight';
      flight.setAttribute('aria-hidden', 'true');
      const image = artwork.querySelector<HTMLImageElement>('img.opacity-100');
      const fallbackImage = source.querySelector<HTMLImageElement>('img.opacity-100');
      const content = (
        image ??
        fallbackImage ??
        artwork.querySelector('.cover-container') ??
        artwork
      ).cloneNode(true) as HTMLElement;
      content.removeAttribute('id');
      content.style.cssText = 'width:100%;height:100%;object-fit:cover;opacity:1';
      if (content.tagName === 'IMG') (content as HTMLImageElement).loading = 'eager';
      content.querySelectorAll<HTMLElement>('.cover-container').forEach((cover) => {
        Object.assign(cover.style, { width: '100%', height: '100%', borderRadius: '0' });
      });
      // A cloned dynamic video cannot retain its decoded frame. Keep the static
      // artwork underneath it instead of starting another decoder for 460 ms.
      content.querySelectorAll('video').forEach((video) => video.remove());
      // Two fixed rounded clips crossfade on the compositor. Animating the
      // border-radius itself would repaint the artwork throughout the zoom.
      const makeClip = (borderRadius: string, artwork: Node) => {
        const clip = document.createElement('div');
        clip.className = 'lyric-cover-flight-clip';
        Object.assign(clip.style, { borderRadius, background });
        clip.append(artwork);
        flight.append(clip);
        return clip;
      };
      const clips: [HTMLElement, HTMLElement] = [
        makeClip(radius, content),
        makeClip(`${smallRadius / scaleX}px / ${smallRadius / scaleY}px`, content.cloneNode(true)),
      ];
      motion.clips = clips;
      Object.assign(flight.style, {
        left: `${large.left}px`,
        top: `${large.top}px`,
        width: `${large.width}px`,
        height: `${large.height}px`,
      });
      document.body.append(flight);
      motion.flight = flight;
      hide(motion, source);
      hide(motion, target);
      const collapsed: Keyframe = {
        transform: `translate(${small.left - large.left}px, ${small.top - large.top}px) scale(${scaleX}, ${scaleY})`,
      };
      const expanded: Keyframe = { transform: 'none' };
      const currentCover: Keyframe | undefined = previous?.cover
        ? {
            transform: `translate(${previous.cover.left - large.left}px, ${previous.cover.top - large.top}px) scale(${previous.cover.width / large.width}, ${previous.cover.height / large.height})`,
          }
        : undefined;
      animate(
        motion,
        flight,
        [
          currentCover ?? (entering || previous?.opacity === '0' ? collapsed : expanded),
          entering ? expanded : collapsed,
        ],
        duration,
        entering,
      );
      animate(
        motion,
        host,
        [{ opacity: previous?.opacity ?? (entering ? 0 : 1) }, { opacity: entering ? 1 : 0 }],
        entering ? 200 : 220,
        entering,
      );

      clips.forEach((clip, index) => {
        const endOpacity = entering ? Number(index === 0) : Number(index === 1);
        const startOpacity = previous?.clipOpacities?.[index] ?? 1 - endOpacity;
        animate(
          motion,
          clip,
          [
            { opacity: startOpacity },
            // Keep one clip opaque during the handover, so the cover doesn't dim.
            { opacity: endOpacity ? 1 : startOpacity, offset: endOpacity ? 0.35 : 0.65 },
            { opacity: endOpacity },
          ],
          duration,
          entering,
        );
      });

      if (entering) {
        host
          .querySelectorAll<HTMLElement>(
            '.lyric-side, .amll-player-area, .song-info, .amll-song-info, .lyric-bar',
          )
          .forEach((element) => {
            animate(
              motion,
              element,
              [
                { opacity: 0, transform: 'translateY(20px)' },
                { opacity: 1, transform: 'none' },
              ],
              360,
              true,
              70,
            );
          });
      }
    } else {
      host.dataset.motion = 'panel';
      const collapsed = { transform: 'translateY(100%)', opacity: 1 };
      const expanded = { transform: 'none', opacity: 1 };
      animate(
        motion,
        host,
        [
          previous
            ? { opacity: previous.opacity, transform: previous.transform }
            : entering
              ? collapsed
              : expanded,
          entering ? expanded : collapsed,
        ],
        duration,
        entering,
      );
    }

    // Only transform and opacity change during the motion; Vue receives one finish.
    await Promise.allSettled(motion.animations.map((animation) => animation.finished));
    if (active !== motion) return;
    cleanup();
    done();
  };

  onScopeDispose(cleanup);

  return {
    beforeEnter: (el: Element) => {
      el.removeAttribute('data-leaving');
      el.setAttribute('data-entering', '');
      (el as HTMLElement).style.opacity = '0';
    },
    enter: (el: Element, done: () => void) => void run(el, done, true),
    leave: (el: Element, done: () => void) => void run(el, done, false),
    cancel: (el: Element) => {
      if (active?.host === el) {
        capture();
        cleanup();
      }
    },
  };
}
