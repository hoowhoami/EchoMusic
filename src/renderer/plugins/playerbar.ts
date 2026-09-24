import { computed, ref, shallowReactive } from 'vue';
import type { PluginIcon } from './registry';
import type { PlayerBarInteractionTrigger, PlayerBarPlacement } from '@/layouts/playerBarActions';

export interface PlayerbarItem {
  id: string;
  title: string;
  icon: PluginIcon;
  tooltip?: string;
  badge?: string | number | null | (() => string | number | null | undefined);
  badgeTitle?: string;
  badgeDefaultVisible?: boolean;
  trigger?: PlayerBarInteractionTrigger;
  defaultPlacement?: PlayerBarPlacement;
  order?: number;
  visible?: boolean | (() => boolean);
  disabled?: boolean | (() => boolean);
  onClick: () => void | Promise<void>;
}

export interface PlayerbarAction {
  key: string;
  id: string;
  pluginId: string | null;
  title: string;
  icon: PluginIcon;
  tooltip: string;
  badge: () => string | null;
  badgeTitle?: string;
  badgeDefaultVisible: boolean;
  trigger: PlayerBarInteractionTrigger;
  defaultPlacement: PlayerBarPlacement;
  order: number;
  visible: () => boolean;
  disabled: () => boolean;
  busy: () => boolean;
  onClick: () => Promise<void>;
}

const items = shallowReactive<PlayerbarAction[]>([]);

export const playerbarItems = computed(() => items.slice());

export const removePlayerbarItemsByPlugin = (pluginId: string) => {
  for (let index = items.length - 1; index >= 0; index--) {
    if (items[index].pluginId === pluginId) items.splice(index, 1);
  }
};

export const createPlayerbarApi = (
  pluginId: string | null,
  addDisposable: (dispose: () => void) => void,
  reportError: (source: string, error: unknown) => void,
) => ({
  register(contribution: PlayerbarItem) {
    const id = String(contribution.id ?? '').trim();
    const title = String(contribution.title ?? '').trim();
    const icon = contribution.icon;
    const validIcon =
      typeof icon === 'string'
        ? Boolean(icon.trim())
        : icon !== null && typeof icon === 'object' && !Array.isArray(icon);
    if (!id || !title || !validIcon || typeof contribution.onClick !== 'function') {
      throw new Error('播放栏操作需要 id、title、icon 和 onClick');
    }
    const placement = contribution.defaultPlacement ?? 'more';
    const trigger = contribution.trigger ?? 'click';
    if (
      placement !== 'left' &&
      placement !== 'center' &&
      placement !== 'right' &&
      placement !== 'more'
    ) {
      throw new Error('defaultPlacement 必须为 left、center、right 或 more');
    }
    if (trigger !== 'click' && trigger !== 'hover') {
      throw new Error('trigger 必须为 click 或 hover');
    }
    const flag = (value: PlayerbarItem['visible'], missing: boolean, failed: boolean) => () => {
      try {
        return typeof value === 'function' ? Boolean(value()) : (value ?? missing);
      } catch (error) {
        reportError(`播放栏状态: ${title}`, error);
        return failed;
      }
    };
    const busy = ref(false);
    const disabled = flag(contribution.disabled, false, true);
    const badge = () => {
      try {
        const value =
          typeof contribution.badge === 'function' ? contribution.badge() : contribution.badge;
        return String(value ?? '').trim() || null;
      } catch (error) {
        reportError(`播放栏徽标: ${title}`, error);
        return null;
      }
    };
    const item: PlayerbarAction = {
      key: JSON.stringify([pluginId, id]),
      id,
      pluginId,
      title,
      icon,
      tooltip: contribution.tooltip?.trim() || title,
      badge,
      badgeTitle: contribution.badgeTitle?.trim() || undefined,
      badgeDefaultVisible: contribution.badgeDefaultVisible !== false,
      trigger,
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
          reportError(`播放栏操作: ${title}`, error);
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
