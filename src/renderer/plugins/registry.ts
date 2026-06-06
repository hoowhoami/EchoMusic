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

export type PluginSettingValue = string | number | boolean | string[] | null;

export type PluginSettingFieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'slider'
  | 'switch'
  | 'select'
  | 'file'
  | 'directory';

export interface PluginSettingOption {
  label: string;
  value: string | number | boolean;
}

export interface PluginSettingField {
  key: string;
  type: PluginSettingFieldType;
  label: string;
  description?: string;
  placeholder?: string;
  default?: PluginSettingValue;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  multiple?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  options?: PluginSettingOption[];
}

export interface PluginSettingSection {
  id: string;
  title?: string;
  description?: string;
  fields: PluginSettingField[];
}

export interface PluginSettingsContribution extends PluginOwnedContribution {
  title?: string;
  description?: string;
  sections: PluginSettingSection[];
  onChange?: (values: Record<string, PluginSettingValue>) => void | Promise<void>;
}

export interface PluginUiRegistryState {
  pages: PluginPageContribution[];
  settings: PluginSettingsContribution[];
  commands: PluginCommand[];
}

export const pluginUiRegistry = reactive<PluginUiRegistryState>({
  pages: [],
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
export const pluginSettingsContributions = computed(() =>
  pluginUiRegistry.settings
    .slice()
    .sort(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) || left.id.localeCompare(right.id),
    ),
);

const pluginSettingFieldTypes = new Set<PluginSettingFieldType>([
  'text',
  'textarea',
  'number',
  'slider',
  'switch',
  'select',
  'file',
  'directory',
]);

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

const normalizeSettingValue = (value: unknown): PluginSettingValue => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => String(item));
  return null;
};

const normalizeNumberOption = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeSettingField = (field: PluginSettingField): PluginSettingField => {
  const rawType = String(field.type || 'text');
  const type = pluginSettingFieldTypes.has(rawType as PluginSettingFieldType)
    ? (rawType as PluginSettingFieldType)
    : 'text';

  return {
    ...field,
    type,
    key: String(field.key || '').trim(),
    label: String(field.label || field.key || '').trim(),
    description: field.description ? String(field.description) : undefined,
    placeholder: field.placeholder ? String(field.placeholder) : undefined,
    default: normalizeSettingValue(field.default),
    unit: field.unit ? String(field.unit) : undefined,
    min: normalizeNumberOption(field.min),
    max: normalizeNumberOption(field.max),
    step: normalizeNumberOption(field.step),
    multiple: Boolean(field.multiple),
    filters: Array.isArray(field.filters)
      ? field.filters
          .map((filter) => ({
            name: String(filter.name || 'Files'),
            extensions: Array.isArray(filter.extensions)
              ? filter.extensions.map((extension) => String(extension).replace(/^\./, ''))
              : [],
          }))
          .filter((filter) => filter.extensions.length > 0)
      : undefined,
    options: Array.isArray(field.options)
      ? field.options.map((option) => ({
          label: String(option.label || option.value),
          value:
            typeof option.value === 'string' ||
            typeof option.value === 'number' ||
            typeof option.value === 'boolean'
              ? option.value
              : String(option.value ?? ''),
        }))
      : undefined,
  };
};

export const removePluginContributions = (pluginId: string) => {
  pluginUiRegistry.pages = pluginUiRegistry.pages.filter((item) => item.pluginId !== pluginId);
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
        contribution: Omit<PluginSettingsContribution, 'pluginId'> & {
          id?: string;
        },
      ) {
        const sections = (Array.isArray(contribution.sections) ? contribution.sections : [])
          .map((section, index) => ({
            ...section,
            id: String(section.id || `section-${index + 1}`).trim(),
            fields: (Array.isArray(section.fields) ? section.fields : [])
              .map(normalizeSettingField)
              .filter((field) => field.key && field.label),
          }))
          .filter((section) => section.id && section.fields.length > 0);

        const item: PluginSettingsContribution = {
          pluginId,
          id: String(contribution.id || 'default').trim(),
          title: contribution.title,
          description: contribution.description,
          sections,
          onChange: contribution.onChange
            ? async (values) => {
                try {
                  await contribution.onChange?.(values);
                } catch (error) {
                  reportError(
                    `插件设置回调: ${contribution.title || contribution.id || 'default'}`,
                    error,
                  );
                  throw error;
                }
              }
            : undefined,
        };
        const dispose = upsertContribution(pluginUiRegistry.settings, item);
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
