import type { EchoPluginManifest } from '../../../shared/plugins';

export const getPluginFeatureTags = (manifest: EchoPluginManifest) => {
  const tags: string[] = [];
  if (manifest.runtime?.miniPlayer) tags.push('Mini 运行时');
  if (manifest.runtime?.desktopLyric) tags.push('桌面歌词');
  if (manifest.capabilities?.theme) tags.push('主题');
  if (manifest.capabilities?.lyricEffects) tags.push('歌词动效');
  if (manifest.capabilities?.lyrics) tags.push('歌词解析');
  if (manifest.capabilities?.audioSource) tags.push('音源解析');
  if (manifest.capabilities?.audioSpectrum) tags.push('音频频谱');
  if (manifest.capabilities?.backups) tags.push('备份与恢复');
  if (manifest.capabilities?.kugouApi) tags.push('酷狗 API');
  if (manifest.capabilities?.kugouVerification) tags.push('酷狗验证');
  if (manifest.capabilities?.localFiles) tags.push('本地文件');
  if (manifest.capabilities?.process) tags.push('本地进程');
  if (manifest.capabilities?.sqlite) tags.push('SQLite');
  if (manifest.capabilities?.unrestrictedNetwork) tags.push('原生网络');
  if (manifest.capabilities?.serverIntercept) tags.push('请求拦截');
  if (manifest.capabilities?.tcp) tags.push('TCP 网络');
  if (manifest.contributes?.windows?.length) tags.push('插件浮窗');
  return tags;
};
