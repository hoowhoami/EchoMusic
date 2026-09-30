import { getHomeDiscover, getSongMetadata } from '@/api/music';
import { applyDiscoverMetadata, mapDiscoverItems } from '@/utils/mappers/discover';
import logger from '@/utils/logger';

export const fetchDiscoverItems = async () => {
  const items = mapDiscoverItems(
    await getHomeDiscover({ support: 'only_song', recallType: 'song' }),
  );
  if (!items.length) return items;
  try {
    return applyDiscoverMetadata(items, await getSongMetadata(items.map((item) => item.key)));
  } catch (error) {
    // Missing metadata must not prevent listening; keep only identities actually returned.
    logger.warn('Discover', 'Song metadata request failed:', error);
    return items;
  }
};
