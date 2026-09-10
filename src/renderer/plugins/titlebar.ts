import { computed, ref, shallowReactive } from 'vue';
import type { PluginIcon } from './registry';

export type TitlebarPlacement = 'toolbar' | 'more';
export interface TitlebarItem {
  id: string;
  title: string;
  icon: PluginIcon;
  tooltip?: string;
  defaultPlacement?: TitlebarPlacement;
  order?: number;
  visible?: boolean | (() => boolean);
  disabled?: boolean | (() => boolean);
  onClick: () => void | Promise<void>;
}
export interface TitlebarLayout {
  placements: Record<string, TitlebarPlacement>;
  order: string[];
}
export const emptyTitlebarLayout = (): TitlebarLayout => ({ placements: {}, order: [] });

export interface TitlebarAction {
  key: string;
  id: string;
  pluginId: string | null;
  title: string;
  icon: PluginIcon;
  tooltip: string;
  defaultPlacement: TitlebarPlacement;
  order: number;
  visible: () => boolean;
  disabled: () => boolean;
  busy: () => boolean;
  onClick: () => Promise<void>;
}
const items = shallowReactive<TitlebarAction[]>([]);
export const titlebarItems = computed(() => items.slice());
export const removeTitlebarItemsByPlugin = (pluginId: string) => {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].pluginId === pluginId) items.splice(index, 1);
  }
};

// null identifies host-owned actions; a plugin cannot claim a built-in preference key.
export const createTitlebarApi = (
  pluginId: string | null,
  addDisposable: (dispose: () => void) => void,
  reportError: (source: string, error: unknown) => void,
) => ({
  register(contribution: TitlebarItem) {
    const id = String(contribution.id ?? '').trim();
    const title = String(contribution.title ?? '').trim();
    const icon = contribution.icon;
    const validIcon =
      typeof icon === 'string'
        ? Boolean(icon.trim())
        : icon !== null && typeof icon === 'object' && !Array.isArray(icon);
    if (!id || !title || !validIcon || typeof contribution.onClick !== 'function') {
      throw new Error('标题栏操作需要 id、title、icon 和 onClick');
    }
    const placement = contribution.defaultPlacement ?? 'more';
    if (placement !== 'toolbar' && placement !== 'more') {
      throw new Error('defaultPlacement 必须为 toolbar 或 more');
    }
    const flag = (value: TitlebarItem['visible'], missing: boolean, failed: boolean) => () => {
      try {
        return typeof value === 'function' ? Boolean(value()) : (value ?? missing);
      } catch (error) {
        reportError(`标题栏状态: ${title}`, error);
        return failed;
      }
    };
    const busy = ref(false);
    const disabled = flag(contribution.disabled, false, true);
    const item: TitlebarAction = {
      key: JSON.stringify([pluginId, id]),
      id,
      pluginId,
      title,
      icon,
      tooltip: contribution.tooltip?.trim() || title,
      defaultPlacement: placement,
      order: Number.isFinite(contribution.order) ? contribution.order! : 1000,
      visible: flag(contribution.visible, true, false),
      disabled: () => busy.value || disabled(),
      busy: () => busy.value,
      onClick: async () => {
        if (!items.includes(item) || !item.visible() || item.disabled()) return;
        busy.value = true;
        try {
          await contribution.onClick();
        } catch (error) {
          reportError(`标题栏操作: ${title}`, error);
        } finally {
          busy.value = false;
        }
      },
    };
    const previous = items.findIndex((entry) => entry.key === item.key);
    if (previous >= 0) items.splice(previous, 1);
    items.push(item);
    const dispose = () => {
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
    };
    addDisposable(dispose);
    return dispose;
  },
});

export function resolveTitlebarLayout(actions: readonly TitlebarAction[], layout?: TitlebarLayout) {
  const order = new Map(
    (Array.isArray(layout?.order) ? layout.order : []).map((key, index) => [key, index]),
  );
  return actions
    .map((action) => {
      const preferred = layout?.placements?.[action.key];
      return {
        ...action,
        placement:
          preferred === 'toolbar' || preferred === 'more' ? preferred : action.defaultPlacement,
        isVisible: action.visible(),
        isDisabled: action.disabled(),
        isBusy: action.busy(),
      };
    })
    .sort(
      (a, b) =>
        (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) ||
        a.order - b.order ||
        a.key.localeCompare(b.key),
    );
}
export type ResolvedTitlebarAction = ReturnType<typeof resolveTitlebarLayout>[number];

// Overflow is a rendering decision, never a saved placement change.
export function partitionTitlebarActions(
  actions: readonly ResolvedTitlebarAction[],
  capacity: number,
) {
  const visible = actions.filter((item) => item.isVisible);
  const toolbar = visible
    .filter((item) => item.placement === 'toolbar')
    .slice(0, Math.max(0, capacity));
  // More is also the pin-management surface, so pinned actions remain accessible there.
  return { toolbar, more: visible };
}

// Replace only the reordered region's slots; preserve other regions and inactive plugins.
export function reorderTitlebarLayout(
  layout: TitlebarLayout,
  actions: readonly { key: string }[],
  keys: string[],
): TitlebarLayout {
  const active = new Set(actions.map((action) => action.key));
  if (new Set(keys).size !== keys.length || keys.some((key) => !active.has(key))) return layout;
  const order = [...new Set(layout?.order ?? [])];
  for (const action of actions) if (!order.includes(action.key)) order.push(action.key);
  const changed = new Set(keys);
  let index = 0;
  return {
    placements: layout?.placements ?? {},
    order: order.map((key) => (changed.has(key) ? keys[index++] : key)),
  };
}
