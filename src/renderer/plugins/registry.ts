import { computed, markRaw, reactive } from 'vue';
import type { Component } from 'vue';
import type { IconifyIcon } from '@iconify/types';
import type { Song } from '@/models/song';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';

export type PluginIcon = string | IconifyIcon | Record<string, unknown>;

export interface PluginOwnedContribution {
  pluginId: string;
  id: string;
}

export interface PluginPageContribution extends PluginOwnedContribution {
  title: string;
  icon?: PluginIcon;
  component: Component;
  order: number;
}

export interface PluginSongContextMenuItem extends PluginOwnedContribution {
  label: string;
  order: number;
  danger?: boolean;
  visible?: (song: unknown) => boolean;
  enabled?: (song: unknown) => boolean;
  onSelect: (song: unknown) => void | Promise<void>;
}

export interface PluginCommand extends PluginOwnedContribution {
  title?: string;
  handler: (...args: unknown[]) => unknown;
}

export interface PluginUiRegistryState {
  pages: PluginPageContribution[];
  commands: PluginCommand[];
}

export const pluginUiRegistry = reactive<PluginUiRegistryState>({
  pages: [],
  commands: [],
});

const pluginSongContextMenuDisposers = new Map<string, () => void>();

const sortByOrder = <T extends { order: number; title?: string; label?: string }>(items: T[]) =>
  items
    .slice()
    .sort(
      (left, right) =>
        left.order - right.order ||
        String(left.title ?? left.label ?? '').localeCompare(
          String(right.title ?? right.label ?? ''),
          'zh-Hans-CN',
        ),
    );

export const pluginPages = computed(() => sortByOrder(pluginUiRegistry.pages));

const removeContribution = <T extends PluginOwnedContribution>(
  list: T[],
  pluginId: string,
  id: string,
) => {
  const index = list.findIndex((item) => item.pluginId === pluginId && item.id === id);
  if (index >= 0) list.splice(index, 1);
};

const upsertContribution = <T extends PluginOwnedContribution>(
  list: T[],
  contribution: T,
): (() => void) => {
  removeContribution(list, contribution.pluginId, contribution.id);
  list.push(contribution);
  return () => removeContribution(list, contribution.pluginId, contribution.id);
};

export const removePluginContributions = (pluginId: string) => {
  pluginUiRegistry.pages = pluginUiRegistry.pages.filter((item) => item.pluginId !== pluginId);
  pluginUiRegistry.commands = pluginUiRegistry.commands.filter(
    (item) => item.pluginId !== pluginId,
  );
  for (const [key, dispose] of pluginSongContextMenuDisposers) {
    if (!key.startsWith(`${pluginId}:`)) continue;
    dispose();
    pluginSongContextMenuDisposers.delete(key);
  }
};

export const createPluginUiApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => void,
) => {
  const withOwner = <T extends { id: string; order?: number }>(contribution: T) => ({
    ...contribution,
    pluginId,
    id: String(contribution.id || '').trim(),
    order: Number(contribution.order ?? 1000),
  });

  const add = (dispose: () => void) => {
    addDisposable(dispose);
    return dispose;
  };

  return {
    addPage(contribution: Omit<PluginPageContribution, 'pluginId' | 'order'> & { order?: number }) {
      const item = withOwner({
        ...contribution,
        component: markRaw(contribution.component),
      });
      const disposePage = upsertContribution(pluginUiRegistry.pages, item);
      return add(disposePage);
    },
    addSongContextMenuItem(
      contribution: Omit<PluginSongContextMenuItem, 'pluginId' | 'order'> & { order?: number },
    ) {
      const item = withOwner(contribution);
      const key = `${item.pluginId}:${item.id}`;
      pluginSongContextMenuDisposers.get(key)?.();
      const dispose = registerSongContextMenuExtension({
        id: key,
        label: item.label,
        order: item.order,
        danger: item.danger,
        visible: item.visible ? (song: Song) => item.visible?.(song) ?? true : undefined,
        enabled: item.enabled ? (song: Song) => item.enabled?.(song) ?? true : undefined,
        onSelect: (song: Song) => item.onSelect(song),
      });
      pluginSongContextMenuDisposers.set(key, dispose);
      return add(() => {
        pluginSongContextMenuDisposers.delete(key);
        dispose();
      });
    },
  };
};

export const registerPluginCommand = (
  pluginId: string,
  command: Omit<PluginCommand, 'pluginId'>,
) => {
  const item = {
    ...command,
    pluginId,
    id: String(command.id || '').trim(),
  };
  const dispose = upsertContribution(pluginUiRegistry.commands, item);
  return dispose;
};

export const executePluginCommand = (commandId: string, ...args: unknown[]) => {
  const command = pluginUiRegistry.commands.find((item) => item.id === commandId);
  if (!command) throw new Error(`插件命令不存在: ${commandId}`);
  return command.handler(...args);
};

export const getPluginPage = (pluginId: string, pageId: string) =>
  pluginUiRegistry.pages.find((page) => page.pluginId === pluginId && page.id === pageId) ?? null;
