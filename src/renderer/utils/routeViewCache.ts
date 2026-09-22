import type { RouteLocationNormalized } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** 只改变页面内部状态、不改变页面实例身份的查询参数。 */
    tabQueryKeys?: readonly string[];
  }
}

export const getRouteViewCacheQuery = (route: Pick<RouteLocationNormalized, 'meta' | 'query'>) => {
  const query = { ...route.query };
  delete query._t;
  // Tab 是页面状态，不改变资源身份；切换时保留当前结果、分页和组件实例。
  for (const key of route.meta.tabQueryKeys ?? []) delete query[key];
  return query;
};

export interface RouteViewCacheKeyUpdate {
  key: string;
  staleKey?: string;
}

const appendRevision = (canonicalKey: string, revision?: string) =>
  revision ? `${canonicalKey}::refresh:${revision}` : canonicalKey;

/**
 * Keep a refreshed route on the same logical cache branch after its transient
 * refresh query parameter is removed by later navigation.
 */
export const updateRouteViewCacheKey = (
  canonicalKey: string,
  refreshToken: string,
  revisions: Map<string, string>,
): RouteViewCacheKeyUpdate => {
  const previousRevision = revisions.get(canonicalKey);

  if (refreshToken && refreshToken !== previousRevision) {
    revisions.set(canonicalKey, refreshToken);
    return {
      key: appendRevision(canonicalKey, refreshToken),
      staleKey: appendRevision(canonicalKey, previousRevision),
    };
  }

  return {
    key: appendRevision(canonicalKey, previousRevision),
  };
};
