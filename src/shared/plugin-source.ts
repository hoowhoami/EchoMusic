import type { PluginInstallSource } from './plugins';

export const getPluginSourceName = (name?: string, url?: string) =>
  name?.trim() || url?.trim() || '未知来源';

export const getInstalledPluginSourceName = (source?: PluginInstallSource) => {
  if (source?.kind === 'local') return '本地安装';
  if (source?.kind === 'marketplace') return getPluginSourceName(source.name, source.url);
  return '未记录来源';
};
