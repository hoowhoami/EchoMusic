import { getHomeDiscover, getSongMetadata, getSongPrivilegeLite } from '@/api/music';
import {
  applyDiscoverMetadata,
  applyDiscoverQualities,
  mapDiscoverItems,
} from '@/utils/mappers/discover';
import logger from '@/utils/logger';

export const fetchDiscoverItems = async () => {
  let items = mapDiscoverItems(await getHomeDiscover({ support: 'only_song', recallType: 'song' }));
  if (!items.length) return items;
  const [metadata, qualities] = await Promise.allSettled([
    getSongMetadata(items.map((item) => item.key)),
    getSongPrivilegeLite(
      items.map((item) => item.song.hash).join(','),
      items.map((item) => String(item.song.albumId || 0)).join(','),
    ),
  ]);
  if (metadata.status === 'fulfilled') items = applyDiscoverMetadata(items, metadata.value);
  else logger.warn('Discover', 'Song metadata request failed:', metadata.reason);
  if (qualities.status === 'fulfilled') items = applyDiscoverQualities(items, qualities.value);
  else logger.warn('Discover', 'Song quality request failed:', qualities.reason);
  return items;
};
