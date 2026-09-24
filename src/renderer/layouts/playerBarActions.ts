import type { PluginIcon } from '@/plugins/registry';

export type PlayerBarPlacement = 'left' | 'center' | 'right' | 'more';
export type PlayerBarInteractionTrigger = 'click' | 'hover';
type PlayerBarSavedPlacement = PlayerBarPlacement | 'toolbar';

export interface PlayerBarLayout {
  placements: Record<string, PlayerBarSavedPlacement>;
  order: string[];
  badges: Record<string, boolean>;
}

export const emptyPlayerBarLayout = (): PlayerBarLayout => ({
  placements: {},
  order: [],
  badges: {},
});

export interface PlayerBarAction {
  key?: string;
  id: string;
  title: string;
  icon: PluginIcon;
  component?: 'sleep-timer' | 'volume' | 'speed' | 'quality' | 'effect' | 'cast';
  trigger?: PlayerBarInteractionTrigger;
  tooltip?: string;
  defaultPlacement: PlayerBarPlacement;
  order: number;
  visible: boolean;
  disabled?: boolean;
  active?: boolean;
  badge?: string | null;
  badgeTitle?: string;
  badgeDefaultVisible?: boolean;
  onClick: () => void | Promise<void>;
}

export interface ResolvedPlayerBarAction extends PlayerBarAction {
  key: string;
  placement: PlayerBarPlacement;
  isBadgeVisible: boolean;
  visibleBadge: string | null;
}

export type PlayerBarPlacementCapacity = Record<'left' | 'center' | 'right', number>;

export interface PartitionedPlayerBarActions {
  left: ResolvedPlayerBarAction[];
  center: ResolvedPlayerBarAction[];
  right: ResolvedPlayerBarAction[];
  overflow: ResolvedPlayerBarAction[];
}

export function resolvePlayerBarActions(
  actions: readonly PlayerBarAction[],
  layout?: PlayerBarLayout,
): ResolvedPlayerBarAction[] {
  const order = new Map(
    (Array.isArray(layout?.order) ? layout.order : []).map((key, index) => [key, index]),
  );
  return actions
    .filter((action) => action.visible)
    .map((action) => {
      const key = action.key ?? action.id;
      const preferred = layout?.placements?.[key];
      const badge = String(action.badge ?? '').trim() || null;
      const badgeDefaultVisible = action.badgeDefaultVisible ?? true;
      const isBadgeVisible =
        Boolean(badge) &&
        (typeof layout?.badges?.[key] === 'boolean' ? layout.badges[key] : badgeDefaultVisible);
      return {
        ...action,
        key,
        placement:
          preferred === 'left' ||
          preferred === 'center' ||
          preferred === 'right' ||
          preferred === 'more'
            ? preferred
            : preferred === 'toolbar'
              ? 'right'
              : action.defaultPlacement,
        isBadgeVisible,
        visibleBadge: isBadgeVisible ? badge : null,
      };
    })
    .sort(
      (left, right) =>
        (order.get(left.key) ?? Infinity) - (order.get(right.key) ?? Infinity) ||
        left.order - right.order ||
        left.key.localeCompare(right.key),
    );
}

const clampCapacity = (value: number | undefined) => Math.max(0, Math.floor(value ?? 0));

export function partitionPlayerBarActions(
  actions: readonly ResolvedPlayerBarAction[],
  capacity: PlayerBarPlacementCapacity,
): PartitionedPlayerBarActions {
  const result: PartitionedPlayerBarActions = {
    left: [],
    center: [],
    right: [],
    overflow: [],
  };
  const remaining = {
    left: clampCapacity(capacity.left),
    center: clampCapacity(capacity.center),
    right: clampCapacity(capacity.right),
  };

  for (const action of actions) {
    if (action.placement === 'more') {
      result.overflow.push(action);
      continue;
    }
    if (remaining[action.placement] > 0) {
      result[action.placement].push(action);
      remaining[action.placement] -= 1;
    } else {
      result.overflow.push(action);
    }
  }

  return result;
}

export function setPlayerBarActionPlacement(
  layout: PlayerBarLayout | undefined,
  actionKey: string,
  placement: PlayerBarPlacement,
): PlayerBarLayout {
  return {
    placements: {
      ...(layout?.placements ?? {}),
      [actionKey]: placement,
    },
    order: layout?.order ?? [],
    badges: layout?.badges ?? {},
  };
}

export function reorderPlayerBarLayout(
  layout: PlayerBarLayout | undefined,
  actions: readonly { key?: string; id: string }[],
  keys: string[],
): PlayerBarLayout {
  const active = new Set(actions.map((action) => action.key ?? action.id));
  if (new Set(keys).size !== keys.length || keys.some((key) => !active.has(key))) {
    return layout ?? emptyPlayerBarLayout();
  }
  const order = [...new Set(layout?.order ?? [])];
  for (const action of actions) {
    const key = action.key ?? action.id;
    if (!order.includes(key)) order.push(key);
  }
  const changed = new Set(keys);
  let index = 0;
  return {
    placements: layout?.placements ?? {},
    badges: layout?.badges ?? {},
    order: order.map((key) => (changed.has(key) ? keys[index++] : key)),
  };
}

export function setPlayerBarBadgeVisible(
  layout: PlayerBarLayout | undefined,
  actionKey: string,
  visible: boolean,
): PlayerBarLayout {
  return {
    placements: layout?.placements ?? {},
    order: layout?.order ?? [],
    badges: {
      ...(layout?.badges ?? {}),
      [actionKey]: visible,
    },
  };
}
