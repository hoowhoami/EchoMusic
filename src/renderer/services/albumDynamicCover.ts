import { getAlbumDynamicCover } from '@/api/album';
import { createAlbumDynamicCoverLoader } from '@/utils/albumDynamicCover';

export const loadAlbumDynamicCover = createAlbumDynamicCoverLoader(({ albumAudioId, albumId }) =>
  getAlbumDynamicCover(albumAudioId, albumId),
);
