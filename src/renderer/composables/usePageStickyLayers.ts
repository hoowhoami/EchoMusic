import { inject, provide, ref, onBeforeUnmount, type InjectionKey, type Ref } from 'vue';
import { planPageStickyLayout } from '@/utils/pageStickyLayout';

export interface PageStickyEntry {
  placeholder: HTMLElement;
  layer: HTMLElement;
  content: HTMLElement;
  top: () => number;
  flowHeight: () => number | undefined;
  visualHeight?: () => number;
}

interface StickyMetric {
  absTop: number;
  left: number;
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  zIndex: string;
}

interface PageStickyLayers {
  target: Ref<HTMLElement | null>;
  register: (entry: PageStickyEntry) => () => void;
  update: () => void;
  invalidate: () => void;
}
const key: InjectionKey<PageStickyLayers> = Symbol('page-sticky-layers');
export const usePageStickyLayers = () => inject(key, null);

export function providePageStickyLayers(scroll: Ref<HTMLElement | null>) {
  const target = ref<HTMLElement | null>(null);
  const topInset = ref(0);
  const entries = new Set<PageStickyEntry>();
  const metrics = new Map<PageStickyEntry, StickyMetric>();
  let viewport = { top: 0, left: 0, height: 0 };
  let stale = true;
  let updateFrame = 0;
  let disposed = false;

  const setStyle = (el: HTMLElement, name: string, value: string) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };

  const measureEntry = (entry: PageStickyEntry, scrollTop: number): StickyMetric => {
    const placeholderRect = entry.placeholder.getBoundingClientRect();
    const contentRect = entry.content.getBoundingClientRect();
    const style = getComputedStyle(entry.content);
    return {
      absTop: placeholderRect.top + scrollTop - viewport.top,
      left: placeholderRect.left - viewport.left,
      width: placeholderRect.width,
      height: contentRect.height,
      marginTop: parseFloat(style.marginTop) || 0,
      marginBottom: parseFloat(style.marginBottom) || 0,
      zIndex: style.zIndex === 'auto' ? '1' : style.zIndex,
    };
  };

  const ensureMetrics = () => {
    if (!stale) return;
    const scrollEl = scroll.value;
    if (!scrollEl) return;
    const rect = scrollEl.getBoundingClientRect();
    viewport = { top: rect.top, left: rect.left, height: rect.height };
    const scrollTop = scrollEl.scrollTop;
    for (const entry of entries) metrics.set(entry, measureEntry(entry, scrollTop));
    stale = false;
  };

  const commitLayout = () => {
    if (!scroll.value || !target.value || !scroll.value.isConnected) return;
    ensureMetrics();
    if (!viewport.height) return;
    const scrollTop = scroll.value.scrollTop;
    const items: {
      entry: PageStickyEntry;
      metric: StickyMetric;
      naturalTop: number;
      stickyTop: number;
      visualHeight: number;
      marginTop: number;
    }[] = [];
    for (const entry of entries) {
      let metric = metrics.get(entry);
      if (!metric) {
        metric = measureEntry(entry, scrollTop);
        metrics.set(entry, metric);
      }
      const naturalTop = metric.absTop - scrollTop;
      const stickyTop = entry.top();
      items.push({
        entry,
        metric,
        naturalTop,
        stickyTop,
        visualHeight: entry.visualHeight?.() ?? metric.height,
        marginTop: metric.marginTop,
      });
    }
    const plan = planPageStickyLayout(items, viewport.height);
    for (let i = 0; i < items.length; i++) {
      const { entry, metric } = items[i];
      const top = plan.tops[i];
      setStyle(entry.layer, 'transform', `translate3d(0, ${top}px, 0)`);
      setStyle(entry.layer, 'left', `${metric.left}px`);
      setStyle(entry.layer, 'width', `${metric.width}px`);
      setStyle(entry.layer, 'z-index', metric.zIndex);
      setStyle(
        entry.placeholder,
        'height',
        `${entry.flowHeight() ?? metric.height + metric.marginTop + metric.marginBottom}px`,
      );
    }
    const inset = plan.inset;
    topInset.value = inset;
    if (scroll.value.dataset.echoStickyInset !== String(inset)) {
      scroll.value.dataset.echoStickyInset = String(inset);
    }
    const container = scroll.value.closest<HTMLElement>('.page-scroll-container');
    if (container) setStyle(container, '--page-sticky-inset', `${inset}px`);
  };

  const update = () => {
    if (disposed || updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      commitLayout();
    });
  };

  const invalidate = () => {
    stale = true;
    update();
  };

  const register = (entry: PageStickyEntry) => {
    entries.add(entry);
    stale = true;
    const resize = new ResizeObserver(invalidate);
    resize.observe(entry.content);
    resize.observe(entry.placeholder);
    let parent = entry.placeholder.parentElement;
    while (parent && parent !== scroll.value) {
      resize.observe(parent);
      parent = parent.parentElement;
    }
    const mutation = new MutationObserver(invalidate);
    mutation.observe(entry.content, {
      attributes: true,
      childList: true,
      attributeFilter: ['style', 'class'],
    });
    update();
    return () => {
      entries.delete(entry);
      metrics.delete(entry);
      resize.disconnect();
      mutation.disconnect();
      stale = true;
      update();
    };
  };

  provide(key, { target, register, update, invalidate });

  const onWheel = (event: WheelEvent) => {
    const viewport = scroll.value;
    if (!viewport || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    let element = event.target instanceof Element ? event.target : null;
    while (element && element !== target.value) {
      if (element instanceof HTMLElement) {
        const style = getComputedStyle(element);
        if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight)
          return;
      }
      element = element.parentElement;
    }
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    viewport.scrollBy({ top: event.deltaY * scale, behavior: 'instant' });
  };

  onBeforeUnmount(() => {
    disposed = true;
    if (updateFrame) cancelAnimationFrame(updateFrame);
    entries.clear();
    metrics.clear();
  });

  return { target, topInset, update, invalidate, onWheel };
}
