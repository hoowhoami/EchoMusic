export const assertBackupManifestMatchesPlugin = (expectedPluginId: string, manifest: unknown) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`插件“${expectedPluginId}”的 manifest.json 无效`);
  }
  const actualPluginId = String((manifest as { id?: unknown }).id ?? '').trim();
  if (!actualPluginId || actualPluginId !== expectedPluginId) {
    throw new Error(
      `插件备份清单 id 与元数据不一致：${actualPluginId || '空'} / ${expectedPluginId}`,
    );
  }
};
