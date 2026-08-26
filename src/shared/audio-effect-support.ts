import type { AudioEffectPlaybackOptions, SpatialAudioEffectEntry } from './audio';
import type { DspProviderManifest } from './player-audio-graph';

export interface AudioEffectSupport {
  status: 'supported' | 'checking' | 'unsupported';
  reason: string;
}
export interface AudioEffectEngineSupport {
  kind: 'builtin' | 'checking' | 'provider';
  manifest?: DspProviderManifest | null;
}

export function spatialAudioEffectOptions(options: {
  providerPath?: string;
  providerMode: 'headphone' | 'speaker';
  providerPresetJson?: string;
  enabled: boolean;
  file: SpatialAudioEffectEntry | null;
  support?: AudioEffectSupport;
}): AudioEffectPlaybackOptions | null {
  const { providerPath, providerMode, providerPresetJson, file } = options;
  if (!options.enabled || !file)
    return providerPath ? { providerPath, providerMode, providerPresetJson } : null;
  if (options.support?.status !== 'supported')
    return providerPath ? { providerPath, providerMode } : null;
  // Combined resources are atomic. Never drop VPF and silently play just IR.
  if (file.vpfPath && !providerPath) return null;
  return {
    providerPath,
    providerMode,
    impulseResponsePath: file.impulseResponsePath,
    providerResources: providerPath
      ? [
          ...(file.vpfPath ? [{ kind: 'vpf', path: file.vpfPath }] : []),
          ...(file.impulseResponsePath
            ? [{ kind: 'impulse-response', path: file.impulseResponsePath }]
            : []),
        ]
      : undefined,
  };
}

export function parseAudioEffectManifest(json?: string): DspProviderManifest | null {
  try {
    const value = JSON.parse(json || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function audioEffectSupport(
  file: SpatialAudioEffectEntry,
  engine: AudioEffectEngineSupport,
): AudioEffectSupport {
  const needsVpf =
    file.kind === 'community-vpf' || file.kind === 'community-combined' || !!file.vpfPath;
  const needsIr = file.kind !== 'community-vpf' || !!file.impulseResponsePath;
  const unsupported = (reason: string): AudioEffectSupport => ({ status: 'unsupported', reason });
  if ((needsVpf && !file.vpfPath) || (needsIr && !file.impulseResponsePath))
    return unsupported('音效文件不完整，请重新下载或导入');
  if (engine.kind === 'checking') return { status: 'checking', reason: '正在检查音效引擎能力' };
  if (engine.kind === 'builtin')
    return needsVpf
      ? unsupported('需要启用支持 VPF 的音效引擎')
      : { status: 'supported', reason: '' };

  const resources = engine.manifest?.resources;
  if (!Array.isArray(resources)) return unsupported('当前引擎未声明音效文件支持能力');
  const supports = (kind: string, path: string) => {
    const extension = /\.[^./\\]+$/.exec(path.split(/[?#]/)[0] ?? '')?.[0]?.toLowerCase();
    return resources.some((resource) => {
      if (typeof resource?.kind !== 'string' || resource.kind.toLowerCase() !== kind) return false;
      if (resource.extensions === undefined) return true;
      return (
        Array.isArray(resource.extensions) &&
        resource.extensions.some(
          (ext) => typeof ext === 'string' && ext.toLowerCase() === extension,
        )
      );
    });
  };
  if (needsVpf && !supports('vpf', file.vpfPath!)) return unsupported('当前引擎不支持此 VPF 音效');
  if (needsIr && !supports('impulse-response', file.impulseResponsePath!))
    return unsupported('当前引擎不支持此卷积音效格式');
  return { status: 'supported', reason: '' };
}
