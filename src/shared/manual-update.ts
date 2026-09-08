export type GithubReleaseAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

export const MAC_MANUAL_UPDATE_MESSAGE =
  '当前 macOS 发行版暂不支持应用内自动安装。请下载 DMG，退出 EchoMusic 后，将新版本拖入「应用程序」替换旧版本。';

// CI currently uses ad-hoc signing on both Mac architectures. Revisit this policy
// only after releases use a stable Developer ID; existing ad-hoc installs still
// need one manual migration. Never bypass Squirrel.Mac signature validation.
export const requiresManualMacUpdate = (platform: string): boolean => platform === 'darwin';

export const getMacDmgAsset = (assets: unknown, arch: string): GithubReleaseAsset | null => {
  if (!Array.isArray(assets)) return null;
  const candidates = assets.filter((asset): asset is GithubReleaseAsset => {
    if (!asset || typeof asset !== 'object') return false;
    return (
      typeof asset.name === 'string' &&
      asset.name.toLowerCase().endsWith('.dmg') &&
      typeof asset.browser_download_url === 'string' &&
      asset.browser_download_url.startsWith('https://')
    );
  });
  const matchesToken = (asset: GithubReleaseAsset, token: string) =>
    String(asset.name).toLowerCase().split(/[-_.]/).includes(token);
  return (
    candidates.find((asset) => matchesToken(asset, arch)) ??
    candidates.find((asset) => matchesToken(asset, 'universal')) ??
    null
  );
};
