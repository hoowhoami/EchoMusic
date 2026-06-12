import { computed, markRaw, reactive } from 'vue';
import type { Component } from 'vue';
import type { IconifyIcon } from '@iconify/types';
import type { Song } from '@/models/song';
import { registerSongContextMenuExtension } from '@/components/music/songContextMenuExtensions';
import {
  registerCoverFallbackResolver,
  removeCoverFallbackResolversByPlugin,
  type CoverFallbackContext,
  type CoverFallbackResolver,
} from './coverFallback';
import { removeAudioSourceResolversByPlugin } from './audioSource';
import { removeLyricResolversByPlugin } from './lyrics';
import { removeLyricEffectsByPlugin } from './lyricEffects';

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

export type PluginSidebarSectionId = 'discover' | 'library' | 'plugins' | string;

export interface PluginPageSidebarOptions {
  id?: string;
  title?: string;
  icon?: PluginIcon;
  section?: PluginSidebarSectionId;
  sectionTitle?: string;
  sectionOrder?: number;
  collapsible?: boolean;
  order?: number;
  before?: string;
  after?: string;
  visible?: boolean | (() => boolean);
  disabled?: boolean | (() => boolean);
}

export type PluginPageRegistration = Omit<PluginPageContribution, 'pluginId' | 'order'> & {
  order?: number;
  sidebar?: boolean | PluginPageSidebarOptions;
};

export interface PluginSidebarItemContribution extends PluginOwnedContribution {
  title: string;
  icon?: PluginIcon;
  section: PluginSidebarSectionId;
  sectionTitle?: string;
  sectionOrder?: number;
  collapsible?: boolean;
  pageId?: string;
  path?: string;
  order: number;
  before?: string;
  after?: string;
  visible?: boolean | (() => boolean);
  disabled?: boolean | (() => boolean);
  onClick?: () => void | Promise<void>;
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

export interface PluginSettingsContribution extends PluginOwnedContribution {
  title?: string;
  description?: string;
  component: Component;
}

export interface PluginCoverFallbackContribution {
  id?: string;
  resolveUrl: CoverFallbackResolver;
}

export type PluginCoverFallbackInput = CoverFallbackResolver | PluginCoverFallbackContribution;

export interface PluginUiRegistryState {
  pages: PluginPageContribution[];
  sidebarItems: PluginSidebarItemContribution[];
  settings: PluginSettingsContribution[];
  commands: PluginCommand[];
}

export const pluginUiRegistry = reactive<PluginUiRegistryState>({
  pages: [],
  sidebarItems: [],
  settings: [],
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
export const pluginSidebarItems = computed(() => sortByOrder(pluginUiRegistry.sidebarItems));
export const pluginSettingsContributions = computed(() =>
  pluginUiRegistry.settings
    .slice()
    .sort(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id),
    ),
);

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
  pluginUiRegistry.sidebarItems = pluginUiRegistry.sidebarItems.filter(
    (item) => item.pluginId !== pluginId,
  );
  pluginUiRegistry.settings = pluginUiRegistry.settings.filter(
    (item) => item.pluginId !== pluginId,
  );
  pluginUiRegistry.commands = pluginUiRegistry.commands.filter(
    (item) => item.pluginId !== pluginId,
  );
  for (const [key, dispose] of pluginSongContextMenuDisposers) {
    if (!key.startsWith(`${pluginId}:`)) continue;
    dispose();
    pluginSongContextMenuDisposers.delete(key);
  }
  removeCoverFallbackResolversByPlugin(pluginId);
  removeAudioSourceResolversByPlugin(pluginId);
  removeLyricResolversByPlugin(pluginId);
  removeLyricEffectsByPlugin(pluginId);
};

export const createPluginUiApi = (
  pluginId: string,
  addDisposable: (dispose: () => void) => void,
  onRuntimeError?: (source: string, error: unknown) => void,
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

  const reportError = (source: string, error: unknown) => {
    onRuntimeError?.(source, error);
  };

  const normalizeCoverFallback = (
    contribution: PluginCoverFallbackInput,
  ): PluginCoverFallbackContribution => {
    if (typeof contribution === 'function') {
      return {
        id: 'default',
        resolveUrl: contribution,
      };
    }

    return {
      id: String(contribution.id || 'default').trim() || 'default',
      resolveUrl: contribution.resolveUrl,
    };
  };

  return {
    addPage(contribution: PluginPageRegistration) {
      const item = withOwner({
        ...contribution,
        component: markRaw(contribution.component),
      });
      const disposePage = upsertContribution(pluginUiRegistry.pages, item);
      const sidebar = contribution.sidebar;
      if (!sidebar) return add(disposePage);

      const sidebarOptions = typeof sidebar === 'object' ? sidebar : {};
      const disposeSidebar = upsertContribution(pluginUiRegistry.sidebarItems, {
        pluginId,
        id: String(sidebarOptions.id || item.id).trim(),
        title: String(sidebarOptions.title || item.title || item.id).trim(),
        icon: sidebarOptions.icon ?? item.icon,
        section: String(sidebarOptions.section || 'plugins').trim() || 'plugins',
        sectionTitle: sidebarOptions.sectionTitle,
        sectionOrder: sidebarOptions.sectionOrder,
        collapsible: sidebarOptions.collapsible,
        pageId: item.id,
        order: Number(sidebarOptions.order ?? item.order),
        before: sidebarOptions.before,
        after: sidebarOptions.after,
        visible: sidebarOptions.visible,
        disabled: sidebarOptions.disabled,
      });
      return add(() => {
        disposeSidebar();
        disposePage();
      });
    },
    sidebar: {
      addItem(
        contribution: Omit<
          PluginSidebarItemContribution,
          'pluginId' | 'id' | 'order' | 'section'
        > & {
          id?: string;
          order?: number;
          section?: PluginSidebarSectionId;
        },
      ) {
        const id = String(contribution.id || contribution.pageId || '').trim();
        if (!id) throw new Error('侧边栏入口 id 不能为空');
        const item = withOwner({
          ...contribution,
          id,
          title: String(contribution.title || id).trim(),
          section: String(contribution.section || 'plugins').trim() || 'plugins',
          pageId: contribution.pageId ? String(contribution.pageId).trim() : id,
          path: contribution.path ? String(contribution.path).trim() : undefined,
          order: contribution.order,
        });
        const dispose = upsertContribution(pluginUiRegistry.sidebarItems, item);
        return add(dispose);
      },
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
        visible: item.visible
          ? (song: Song) => {
              try {
                return item.visible?.(song) ?? true;
              } catch (error) {
                reportError(`歌曲菜单可见性: ${item.label}`, error);
                return false;
              }
            }
          : undefined,
        enabled: item.enabled
          ? (song: Song) => {
              try {
                return item.enabled?.(song) ?? true;
              } catch (error) {
                reportError(`歌曲菜单可用性: ${item.label}`, error);
                return false;
              }
            }
          : undefined,
        onSelect: async (song: Song) => {
          try {
            await item.onSelect(song);
          } catch (error) {
            reportError(`歌曲菜单操作: ${item.label}`, error);
          }
        },
      });
      pluginSongContextMenuDisposers.set(key, dispose);
      return add(() => {
        pluginSongContextMenuDisposers.delete(key);
        dispose();
      });
    },
    settings: {
      define(
        contribution: Omit<PluginSettingsContribution, 'pluginId' | 'id'> & {
          id?: string;
        },
      ) {
        const rawContribution = contribution as Record<string, unknown>;
        if (
          'sections' in rawContribution ||
          'fields' in rawContribution ||
          'onChange' in rawContribution
        ) {
          throw new Error(
            'ctx.ui.settings.define 已移除 sections/fields/onChange 设置方式，请提供 component',
          );
        }

        if (!contribution.component) {
          throw new Error('ctx.ui.settings.define 需要提供 component');
        }

        const item: PluginSettingsContribution = {
          pluginId,
          id: String(contribution.id || 'default').trim(),
          title: contribution.title,
          description: contribution.description,
          component: markRaw(contribution.component),
        };
        const dispose = upsertContribution(pluginUiRegistry.settings, item);
        return add(dispose);
      },
    },
    cover: {
      setFallback(contribution: PluginCoverFallbackInput) {
        const item = normalizeCoverFallback(contribution);
        if (typeof item.resolveUrl !== 'function') {
          throw new Error('封面兜底 resolveUrl 必须是函数');
        }

        const dispose = registerCoverFallbackResolver({
          pluginId,
          id: item.id || 'default',
          resolveUrl: (context: CoverFallbackContext) => {
            try {
              const value = item.resolveUrl(context) as unknown;
              if (value instanceof Promise) {
                reportError(
                  `封面兜底: ${item.id || 'default'}`,
                  new Error('封面兜底 resolver 必须同步返回字符串'),
                );
                return null;
              }
              return typeof value === 'string' || value === null || value === undefined
                ? value
                : null;
            } catch (error) {
              reportError(`封面兜底: ${item.id || 'default'}`, error);
              return null;
            }
          },
        });
        return add(dispose);
      },
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
