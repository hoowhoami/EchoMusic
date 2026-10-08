import { useSettingStore } from '@/stores/setting';
import { waitForSqlitePersistHydration } from '@/stores/sqlitePersist';
import { normalizeShortcutKeys } from '@/layouts/sidebarLayout';
import { builtinSidebarShortcuts, resolveSidebarHomeEntry } from '@/layouts/sidebarShortcutEntries';
import { resourceShortcutKey } from '@/layouts/sidebarShortcutResources';

/** 读取恢复后的卡片顺序，插件首页等待首次注册完成，避免启动时误选推荐页。 */
export async function getSidebarHomeEntry() {
  const settings = useSettingStore();
  await waitForSqlitePersistHydration();
  const first = normalizeShortcutKeys(settings.sidebarLayout.shortcutKeys)[0];
  const isBuiltin = builtinSidebarShortcuts.some((entry) => entry.key === first);
  const isResource = (settings.sidebarLayout.shortcutResources ?? []).some(
    (resource) => resourceShortcutKey(resource) === first,
  );
  if (!isBuiltin && !isResource) {
    const { waitForPluginRuntimeReady } = await import('@/plugins/runtime');
    await waitForPluginRuntimeReady();
  }
  return resolveSidebarHomeEntry(settings.sidebarLayout);
}
