import { computed, shallowReactive } from 'vue';
import type { PluginIcon } from './registry';

export interface MoreMenuItem {
  id: string;
  title: string;
  icon?: PluginIcon;
  order?: number;
  visible?: boolean | (() => boolean);
  disabled?: boolean | (() => boolean);
  onClick: () => void | Promise<void>;
}

const items = shallowReactive<(MoreMenuItem & { pluginId: string })[]>([]);
export const pluginMoreMenuItems = computed(() =>
  items
    .filter((item) =>
      typeof item.visible === 'function' ? item.visible() : item.visible !== false,
    )
    .slice()
    .sort(
      (a, b) =>
        (a.order ?? 1000) - (b.order ?? 1000) ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.id.localeCompare(b.id),
    ),
);
export const removeMoreMenuItemsByPlugin = (pluginId: string) => {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].pluginId === pluginId) items.splice(index, 1);
  }
};

export const createMoreMenuApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => void,
  reportError: (source: string, error: unknown) => void,
) => ({
  addItem(contribution: MoreMenuItem) {
    const id = String(contribution.id ?? '').trim();
    const title = String(contribution.title ?? '').trim();
    if (!id || !title || typeof contribution.onClick !== 'function') {
      throw new Error('更多菜单入口需要 id、title 和 onClick');
    }
    const flag = (value: MoreMenuItem['visible'], fallback: boolean) => () => {
      try {
        return typeof value === 'function' ? Boolean(value()) : (value ?? fallback);
      } catch (error) {
        reportError(`更多菜单状态: ${title}`, error);
        return fallback;
      }
    };
    const item = {
      ...contribution,
      id,
      title,
      pluginId,
      order: Number.isFinite(contribution.order) ? contribution.order : 1000,
      visible: flag(contribution.visible, false),
      disabled: flag(contribution.disabled, true),
      onClick: async () => {
        if (!items.includes(item) || !item.visible() || item.disabled()) return;
        try {
          await contribution.onClick();
        } catch (error) {
          reportError(`更多菜单操作: ${title}`, error);
        }
      },
    };
    // Missing flags default to visible/enabled; failed predicates fail closed.
    if (contribution.visible === undefined) item.visible = () => true;
    if (contribution.disabled === undefined) item.disabled = () => false;
    const previous = items.findIndex((entry) => entry.pluginId === pluginId && entry.id === id);
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
