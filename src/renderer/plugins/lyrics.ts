import type { Song } from '@/models/song';

export interface PluginLyricResolveContext {
  hash: string;
  track?: Song;
  duration: number;
  force: boolean;
  preserveCurrent: boolean;
}

export type PluginLyricResolveResult =
  | string
  | {
      lyric?: string;
      decodeContent?: string;
      content?: string;
      source?: string;
    }
  | null
  | undefined
  | false;

export interface PluginLyricResolverContribution {
  id?: string;
  order?: number;
  match?: (context: PluginLyricResolveContext) => boolean | Promise<boolean>;
  resolve: (
    context: PluginLyricResolveContext,
  ) => PluginLyricResolveResult | Promise<PluginLyricResolveResult>;
}

export interface ResolvedPluginLyric {
  pluginId: string;
  resolverId: string;
  source: string;
  decodeContent: string;
}

interface RegisteredPluginLyricResolver {
  pluginId: string;
  id: string;
  order: number;
  match?: PluginLyricResolverContribution['match'];
  resolve: PluginLyricResolverContribution['resolve'];
  onError?: (source: string, error: unknown) => void;
}

const lyricResolvers: RegisteredPluginLyricResolver[] = [];
const PLUGIN_LYRIC_RESOLVER_TIMEOUT_MS = 2500;

const withResolverTimeout = async <T>(task: Promise<T>, source: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${source} 超时`));
    }, PLUGIN_LYRIC_RESOLVER_TIMEOUT_MS);

    task.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });

const normalizeLyricResolveResult = (
  resolver: Pick<RegisteredPluginLyricResolver, 'pluginId' | 'id'>,
  result: PluginLyricResolveResult,
): ResolvedPluginLyric | null => {
  const value = typeof result === 'string' ? { decodeContent: result } : result;
  if (!value || typeof value !== 'object') return null;

  const decodeContent = String(value.decodeContent ?? value.lyric ?? value.content ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!decodeContent) return null;

  return {
    pluginId: resolver.pluginId,
    resolverId: resolver.id,
    source: String(value.source || resolver.id || resolver.pluginId).trim(),
    decodeContent,
  };
};

const sortLyricResolvers = () => {
  lyricResolvers.sort(
    (left, right) =>
      left.order - right.order ||
      left.pluginId.localeCompare(right.pluginId, 'zh-Hans-CN') ||
      left.id.localeCompare(right.id, 'zh-Hans-CN'),
  );
};

export const registerPluginLyricResolver = (
  pluginId: string,
  contribution: PluginLyricResolverContribution,
  onError?: (source: string, error: unknown) => void,
) => {
  const id = String(contribution.id || 'default').trim() || 'default';
  const key = `${pluginId}:${id}`;
  const existingIndex = lyricResolvers.findIndex(
    (item) => item.pluginId === pluginId && item.id === id,
  );
  if (existingIndex >= 0) lyricResolvers.splice(existingIndex, 1);

  if (typeof contribution.resolve !== 'function') {
    throw new Error('歌词解析 resolve 必须是函数');
  }

  lyricResolvers.push({
    pluginId,
    id,
    order: Number(contribution.order ?? 1000),
    match: contribution.match,
    resolve: contribution.resolve,
    onError,
  });
  sortLyricResolvers();

  return () => {
    const index = lyricResolvers.findIndex((item) => `${item.pluginId}:${item.id}` === key);
    if (index >= 0) lyricResolvers.splice(index, 1);
  };
};

export const removeLyricResolversByPlugin = (pluginId: string) => {
  for (let index = lyricResolvers.length - 1; index >= 0; index -= 1) {
    if (lyricResolvers[index].pluginId === pluginId) {
      lyricResolvers.splice(index, 1);
    }
  }
};

export const resolvePluginLyric = async (
  context: PluginLyricResolveContext,
): Promise<ResolvedPluginLyric | null> => {
  for (const resolver of lyricResolvers.slice()) {
    const source = `歌词解析: ${resolver.id}`;
    try {
      const matched = resolver.match
        ? await withResolverTimeout(Promise.resolve(resolver.match(context)), source)
        : true;
      if (!matched) continue;

      const result = normalizeLyricResolveResult(
        resolver,
        await withResolverTimeout(Promise.resolve(resolver.resolve(context)), source),
      );
      if (result) return result;
    } catch (error) {
      resolver.onError?.(source, error);
    }
  }

  return null;
};
