import { inject, provide, ref, onBeforeUnmount, type InjectionKey, type Ref } from 'vue';
import { planPageStickyLayout } from '@/utils/pageStickyLayout';

export interface PageStickyEntry {
  placeholder: HTMLElement;
  layer: HTMLElement;
  content: HTMLElement;
  top: () => number;
  flowHeight: () => number | undefined;
}
interface PageStickyLayers {
  target: Ref<HTMLElement | null>;
  register: (entry: PageStickyEntry) => () => void;
  update: () => void;
}
const key: InjectionKey<PageStickyLayers> = Symbol('page-sticky-layers');
export const usePageStickyLayers = () => inject(key, null);

export function providePageStickyLayers(scroll: Ref<HTMLElement | null>) {
  const target = ref<HTMLElement | null>(null);
  const topInset = ref(0);
  const entries = new Set<PageStickyEntry>();
  const setStyle = (el: HTMLElement, name: string, value: string) => {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
  };
  const update = () => {
    if (!scroll.value || !target.value || !scroll.value.isConnected) return;
    const viewport = scroll.value.getBoundingClientRect();
    if (!viewport.width || !viewport.height) return;
    const measured = [...entries].map((entry) => {
      const rect = entry.placeholder.getBoundingClientRect();
      const contentRect = entry.content.getBoundingClientRect();
      const style = getComputedStyle(entry.content);
      const marginTop = parseFloat(style.marginTop) || 0;
      const marginBottom = parseFloat(style.marginBottom) || 0;
      const height = contentRect.height;
      const visualHeight =
        parseFloat(entry.content.style.getPropertyValue('--sliver-background-height')) || height;
      const naturalTop = rect.top - viewport.top;
      const stickyTop = entry.top();
      return {
        entry,
        rect,
        naturalTop,
        stickyTop,
        visualHeight,
        style,
        height,
        marginTop,
        marginBottom,
      };
    });
    const plan = planPageStickyLayout(measured, viewport.height);
    // Header geometry and the viewport barrier are committed together. The barrier
    // stays put during compositor scrolling; no row-by-row clips chase scrollTop.
    for (const [index, item] of measured.entries()) {
      const { entry, rect, style, height, marginTop, marginBottom } = item;
      const top = plan.tops[index];
      setStyle(entry.layer, 'top', `${top}px`);
      setStyle(entry.layer, 'left', `${rect.left - viewport.left}px`);
      setStyle(entry.layer, 'width', `${rect.width}px`);
      setStyle(entry.layer, 'z-index', style.zIndex === 'auto' ? '1' : style.zIndex);
      setStyle(
        entry.placeholder,
        'height',
        `${entry.flowHeight() ?? height + marginTop + marginBottom}px`,
      );
    }
    const inset = plan.inset;
    topInset.value = inset;
    scroll.value.dataset.echoStickyInset = String(inset);
    setStyle(
      scroll.value.closest('.page-scroll-container') as HTMLElement,
      '--page-sticky-inset',
      `${inset}px`,
    );
  };
  const register = (entry: PageStickyEntry) => {
    entries.add(entry);
    const resize = new ResizeObserver(update);
    resize.observe(entry.content);
    resize.observe(entry.placeholder);
    const mutation = new MutationObserver(update);
    mutation.observe(entry.content, {
      attributes: true,
      subtree: true,
      childList: true,
      attributeFilter: ['style', 'class'],
    });
    update();
    return () => {
      entries.delete(entry);
      resize.disconnect();
      mutation.disconnect();
      update();
    };
  };
  provide(key, { target, register, update });
  const onWheel = (event: WheelEvent) => {
    const viewport = scroll.value;
    if (!viewport || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    let element = event.target instanceof Element ? event.target : null;
    // Dropdowns and other nested scroll controls retain their own wheel behavior.
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
  onBeforeUnmount(() => entries.clear());
  return { target, topInset, update, onWheel };
}
