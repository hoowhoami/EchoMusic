import { createVNode, render, type AppContext, type VNode } from 'vue';
import TooltipHost from './tooltip/TooltipHost.vue';
import { setTooltipOwner } from './tooltipOwnership';

export type TooltipMode = 'auto' | 'overflow' | 'always';

export interface TooltipOptions {
  content?: string;
  renderContent?: () => VNode[];
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  delayDuration?: number;
  disabled?: boolean;
  mode?: TooltipMode;
  ignoreNonKeyboardFocus?: boolean;
  contentClass?: string;
}
export type TooltipValue = string | TooltipOptions | null | undefined | false;
export interface TooltipEntry {
  element: HTMLElement;
  options: TooltipOptions;
  suspended: boolean;
  appContext?: AppContext;
}

const normalize = (value: TooltipValue): TooltipOptions =>
  typeof value === 'string' ? { content: value } : { ...(value || {}) };
const documents = new WeakMap<Document, ReturnType<typeof createTooltipRuntime>>();
let nextId = 0;

// One set of delegated listeners and one active floating surface per document.
export function createTooltipRuntime(doc: Document) {
  const targets = new Map<HTMLElement, TooltipEntry[]>();
  let pending: TooltipEntry | undefined;
  let active: TooltipEntry | undefined;
  let container: HTMLElement | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let monitor: MutationObserver | undefined;
  let tooltipId = '';
  let releaseOwner = () => {};
  let keyboardFocus = false;
  let lastClosedAt = -Infinity;
  let transit: { x: number; y: number; fromSurface: boolean } | undefined;

  const labelOverflows = (label: HTMLElement) => {
    if (label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight + 1)
      return true;
    // Input placeholders do not contribute to scrollWidth. Measure their visible text.
    if (label.tagName !== 'INPUT' || label.clientWidth === 0) return false;
    const input = label as HTMLInputElement;
    const text = input.value || input.placeholder;
    const style = doc.defaultView?.getComputedStyle(input);
    const context = doc.createElement('canvas').getContext('2d');
    if (!text || !style || !context) return false;
    context.font = style.font;
    const spacing = parseFloat(style.letterSpacing) || 0;
    const textWidth = context.measureText(text).width + Math.max(0, [...text].length - 1) * spacing;
    const availableWidth =
      input.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) -
      (parseFloat(style.textIndent) || 0);
    return textWidth > availableWidth;
  };

  const textKey = (text: string) => text.replace(/\s+/g, '').trim();
  const visibleLabelText = (label: HTMLElement) => {
    if (!label.getClientRects().length) return '';
    if (label.tagName === 'INPUT') {
      const input = label as HTMLInputElement;
      return input.value || input.placeholder;
    }
    return label.innerText || '';
  };

  const eligible = (entry: TooltipEntry) => {
    const { element, options } = entry;
    if (
      entry.suspended ||
      options.disabled ||
      (!options.content?.trim() && !options.renderContent) ||
      !element.isConnected ||
      element.closest('[hidden], [inert], [aria-hidden="true"]') ||
      element.closest('.echo-popover-trigger[data-state="open"], [aria-expanded="true"]')
    )
      return false;
    const style = doc.defaultView?.getComputedStyle(element);
    if (style?.visibility === 'hidden' || style?.display === 'none') return false;
    if (options.mode === 'always' || options.renderContent) return true;
    const labels = element.querySelectorAll<HTMLElement>('[data-tooltip-label]');
    const textLabels = labels.length ? Array.from(labels) : [element];
    if (options.mode !== 'overflow') {
      const content = textKey(options.content || '');
      const repeatsVisibleText = [element, ...textLabels].some(
        (label) => textKey(visibleLabelText(label)) === content,
      );
      if (!repeatsVisibleText) return true;
    }
    return textLabels.some(labelOverflows);
  };
  const clearTimers = () => {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = undefined;
  };
  const close = () => {
    clearTimers();
    pending = undefined;
    monitor?.disconnect();
    monitor = undefined;
    if (active) {
      const describedBy = (active.element.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== tooltipId);
      if (describedBy.length)
        active.element.setAttribute('aria-describedby', describedBy.join(' '));
      else active.element.removeAttribute('aria-describedby');
      lastClosedAt = Date.now();
    }
    active = undefined;
    transit = undefined;
    releaseOwner();
    releaseOwner = () => {};
    if (container) {
      render(null, container);
      container.remove();
      container = undefined;
    }
  };
  const observe = (entry: TooltipEntry) => {
    monitor?.disconnect();
    monitor = new MutationObserver(() => {
      if (!eligible(entry)) close();
    });
    monitor.observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'hidden',
        'inert',
        'aria-hidden',
        'aria-expanded',
        'data-state',
        'disabled',
      ],
    });
  };
  const show = (entry: TooltipEntry) => {
    if (!eligible(entry)) return close();
    pending = undefined;
    active = entry;
    tooltipId = `echo-tooltip-${++nextId}`;
    const describedBy = entry.element.getAttribute('aria-describedby');
    entry.element.setAttribute(
      'aria-describedby',
      [describedBy, tooltipId].filter(Boolean).join(' '),
    );
    container = doc.createElement('div');
    container.dataset.tooltipHost = '';
    releaseOwner = setTooltipOwner(container, entry.element);
    doc.body.appendChild(container);
    const vnode = createVNode(TooltipHost, { entry, tooltipId, onDismiss: close });
    vnode.appContext = entry.appContext ?? null;
    render(vnode, container);
    observe(entry);
  };
  const schedule = (entry: TooltipEntry, focus = false) => {
    clearTimeout(closeTimer);
    if (active === entry || pending === entry) return;
    close();
    if (!eligible(entry)) return;
    pending = entry;
    observe(entry);
    const delay =
      focus || Date.now() - lastClosedAt < 300 ? 0 : (entry.options.delayDuration ?? 350);
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (pending === entry) show(entry);
    }, delay);
  };
  const find = (target: EventTarget | null): TooltipEntry | undefined => {
    let element = target instanceof doc.defaultView!.Element ? target : null;
    while (element) {
      const entry = targets.get(element as HTMLElement)?.at(-1);
      if (entry) return entry;
      element = element.parentElement;
    }
  };
  const inSurface = (target: EventTarget | null) =>
    target instanceof doc.defaultView!.Node && Boolean(container?.contains(target));
  const pointerOver = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    if (inSurface(event.target)) return void clearTimeout(closeTimer);
    const entry = find(event.target);
    if (entry) schedule(entry);
  };
  const pointerOut = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return;
    const from = find(event.target);
    if (!inSurface(event.target) && (!from || (from !== pending && from !== active))) return;
    if (inSurface(event.relatedTarget)) return void clearTimeout(closeTimer);
    const next = find(event.relatedTarget);
    if (next && (next === pending || next === active)) return;
    if (next) return schedule(next);
    if (pending) return close();
    transit = { x: event.clientX, y: event.clientY, fromSurface: inSurface(event.target) };
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 160);
  };
  const pointerMove = (event: PointerEvent) => {
    if (!active || !transit || event.pointerType === 'touch') return;
    if (inSurface(event.target) || find(event.target) === active) {
      transit = undefined;
      return void clearTimeout(closeTimer);
    }
    const surface = container?.firstElementChild;
    if (!surface) return close();
    const destination = (transit.fromSurface ? active.element : surface).getBoundingClientRect();
    const dx = (destination.left + destination.right) / 2 - transit.x;
    const dy = (destination.top + destination.bottom) / 2 - transit.y;
    // Keep the corridor from the exit point to the destination's near edge hoverable.
    // Slow pointer travel across the arrow gap must not time out the tooltip.
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const edge = horizontal
      ? dx > 0
        ? destination.left
        : destination.right
      : dy > 0
        ? destination.top
        : destination.bottom;
    const start = horizontal ? transit.x : transit.y;
    const progress = ((horizontal ? event.clientX : event.clientY) - start) / (edge - start || 1);
    const origin = horizontal ? transit.y : transit.x;
    const low = horizontal ? destination.top : destination.left;
    const high = horizontal ? destination.bottom : destination.right;
    const cross = horizontal ? event.clientY : event.clientX;
    if (
      progress >= 0 &&
      progress <= 1 &&
      cross >= origin + (low - origin) * progress - 4 &&
      cross <= origin + (high - origin) * progress + 4
    )
      clearTimeout(closeTimer);
    else close();
  };
  const focusIn = (event: FocusEvent) => {
    const entry = find(event.target);
    if (entry && (keyboardFocus || entry.options.ignoreNonKeyboardFocus === false))
      schedule(entry, true);
  };
  const focusOut = (event: FocusEvent) => {
    if (find(event.target) === active || find(event.target) === pending) close();
  };
  const pointerDown = () => {
    keyboardFocus = false;
    close();
  };
  const keyDown = (event: KeyboardEvent) => {
    keyboardFocus = true;
    if (event.key === 'Escape') close();
  };
  const scroll = (event: Event) => {
    if (inSurface(event.target)) return;
    if (active || pending) close();
  };
  const visibility = () => {
    if (doc.hidden) close();
  };
  const listeners: [string, EventListener][] = [
    ['pointerover', pointerOver as EventListener],
    ['pointerout', pointerOut as EventListener],
    ['pointermove', pointerMove as EventListener],
    ['pointerdown', pointerDown],
    ['focusin', focusIn as EventListener],
    ['focusout', focusOut as EventListener],
    ['keydown', keyDown as EventListener],
    ['scroll', scroll],
    ['visibilitychange', visibility],
  ];
  const attach = () => {
    for (const [type, handler] of listeners) doc.addEventListener(type, handler, true);
    doc.defaultView?.addEventListener('blur', close);
    doc.defaultView?.addEventListener('resize', close);
  };
  const detach = () => {
    close();
    for (const [type, handler] of listeners) doc.removeEventListener(type, handler, true);
    doc.defaultView?.removeEventListener('blur', close);
    doc.defaultView?.removeEventListener('resize', close);
  };
  return {
    bind(element: HTMLElement, value: TooltipValue, appContext?: AppContext) {
      const entry: TooltipEntry = {
        element,
        options: normalize(value),
        suspended: false,
        appContext,
      };
      if (!targets.size) attach();
      const entries = targets.get(element) ?? [];
      const previous = entries.at(-1);
      if (previous && (previous === active || previous === pending)) close();
      entries.push(entry);
      targets.set(element, entries);
      return {
        update(value: TooltipValue) {
          const options = normalize(value);
          if (
            Object.keys({ ...entry.options, ...options }).every(
              (key) =>
                entry.options[key as keyof TooltipOptions] === options[key as keyof TooltipOptions],
            )
          )
            return;
          if (active === entry || pending === entry) close();
          entry.options = options;
        },
        suspend(suspended: boolean) {
          entry.suspended = suspended;
          if (suspended && (active === entry || pending === entry)) close();
        },
        dispose() {
          const entries = targets.get(element);
          const index = entries?.indexOf(entry) ?? -1;
          if (!entries || index < 0) return;
          if (active === entry || pending === entry) close();
          entries.splice(index, 1);
          if (!entries.length) targets.delete(element);
          if (!targets.size) detach();
        },
      };
    },
  };
}

export function bindTooltip(element: HTMLElement, value: TooltipValue, appContext?: AppContext) {
  const doc = element.ownerDocument;
  let runtime = documents.get(doc);
  if (!runtime) {
    runtime = createTooltipRuntime(doc);
    documents.set(doc, runtime);
  }
  return runtime.bind(element, value, appContext);
}
