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
