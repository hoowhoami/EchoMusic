import type { EchoPluginDescriptor, PluginMarketplacePlugin, PluginInstallSource } from './plugins';

export const getPluginSourceName = (name?: string, url?: string) =>
  name?.trim() || url?.trim() || '未知来源';

export const getInstalledPluginSourceName = (source?: PluginInstallSource) => {
  if (source?.kind === 'local') return '本地安装';
  if (source?.kind === 'marketplace') return getPluginSourceName(source.name, source.url);
  return '未记录来源';
};

// Legacy installs have no catalog snapshot. Only accept an unambiguous matching entry.
export const findInstalledPluginCatalogTags = (
  descriptor: Pick<EchoPluginDescriptor, 'id' | 'name' | 'version' | 'author' | 'installSource'>,
  catalog: Pick<
    PluginMarketplacePlugin,
    'id' | 'name' | 'version' | 'author' | 'sourceId' | 'sourceUrl' | 'tags'
  >[],
): string[] => {
  const source = descriptor.installSource;
  if (source?.kind === 'local') return [];
  const matches = catalog.filter(
    (plugin) =>
      plugin.id === descriptor.id &&
      (source?.kind === 'marketplace'
        ? plugin.sourceId === source.id && plugin.sourceUrl === source.url
        : plugin.name === descriptor.name &&
          plugin.version === descriptor.version &&
          plugin.author === descriptor.author),
  );
  return matches.length === 1 ? matches[0].tags : [];
};
