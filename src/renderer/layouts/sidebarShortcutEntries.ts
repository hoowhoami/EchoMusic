import {
  iconSparkles,
  iconCompass,
  iconVinyl,
  iconRadio,
  iconCalendar,
  iconShoppingBag,
  iconHeadphones,
  iconArrowsSort,
} from '@/icons';
import { pluginShortcuts, pluginPages, type PluginIcon as IconValue } from '@/plugins/registry';
import { normalizeShortcutKeys, type SidebarLayout } from './sidebarLayout';
import {
  resourceShortcutKey,
  resourceShortcutPath,
  type SidebarShortcutResource,
} from './sidebarShortcutResources';
export interface SidebarShortcutEntry {
  key: string;
  title: string;
  icon?: IconValue;
  path?: string;
  onClick?: () => void | Promise<void>;
  source?: string;
  disabled?: boolean;
  resource?: SidebarShortcutResource;
}
export const builtinSidebarShortcuts: SidebarShortcutEntry[] = [
  { key: 'home', title: '为您推荐', icon: iconSparkles, path: '/main/home' },
  { key: 'explore', title: '探索发现', icon: iconCompass, path: '/main/explore' },
  { key: 'discover-flow', title: '刷歌', icon: iconVinyl, path: '/main/discover-flow' },
  { key: 'personal-fm', title: '私人 FM', icon: iconRadio, path: '/main/personal-fm' },
  { key: 'recommend', title: '每日推荐', icon: iconCalendar, path: '/main/recommend' },
  { key: 'ranking', title: '排行榜', icon: iconArrowsSort, path: '/main/ranking' },
  { key: 'purchased', title: '已购音乐', icon: iconShoppingBag, path: '/main/purchased' },
  { key: 'listen-together', title: '一起听', icon: iconHeadphones, path: '/main/listen-together' },
];
const flag = (value: boolean | (() => boolean) | undefined, fallback: boolean) => {
  try {
    return typeof value === 'function' ? value() : (value ?? fallback);
  } catch {
    return fallback;
  }
};
export const getSidebarFunctionEntries = (): SidebarShortcutEntry[] => [
  ...builtinSidebarShortcuts,
  ...pluginShortcuts.value
    .filter(
      (e) =>
        flag(e.visible, true) &&
        (!e.pageId ||
          pluginPages.value.some((page) => page.pluginId === e.pluginId && page.id === e.pageId)),
    )
    .map((e) => ({
      key: e.key,
      title: e.title,
      icon: e.icon,
      source: e.pluginId,
      path: e.pageId
        ? `/main/plugin/${encodeURIComponent(e.pluginId)}/${encodeURIComponent(e.pageId)}`
        : undefined,
      onClick: e.onClick,
      disabled: flag(e.disabled, false),
    })),
];

/** 暂不可用的插件保留配置；没有任何可显示卡片时提供推荐页入口。 */
export function resolveSidebarShortcutEntries(
  keys: readonly string[] | undefined,
  catalogue: readonly SidebarShortcutEntry[],
): SidebarShortcutEntry[] {
  const entries = normalizeShortcutKeys(keys).flatMap((key) => {
    const entry = catalogue.find((item) => item.key === key);
    return entry ? [entry] : [];
  });
  return entries.length ? entries : [builtinSidebarShortcuts[0]];
}
export function resolveSidebarHomeEntry(layout: SidebarLayout): SidebarShortcutEntry {
  const resources = (layout.shortcutResources ?? []).map((resource) => ({
    key: resourceShortcutKey(resource),
    title: resource.title,
    path: resourceShortcutPath(resource),
    resource,
  }));
  return resolveSidebarShortcutEntries(layout.shortcutKeys, [
    ...getSidebarFunctionEntries(),
    ...resources,
  ])[0];
}
