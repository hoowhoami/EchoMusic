import request from '@/utils/request';
import { normalizeVideoId, assertVideoCollectionSuccess } from '@/utils/videoCollection';

export async function setVideoCollected(id: string | number, collected: boolean) {
  const videoId = normalizeVideoId(id);
  if (!videoId) throw new Error('无效的 MV ID');
  const response = await request.get(collected ? '/mv/collect' : '/mv/collect/del', {
    params: { id: videoId },
  });
  assertVideoCollectionSuccess(response);
  return response;
}

export function getVideoUrl(hash: string) {
  return request.get('/video/url', {
    params: { hash },
  });
}

export function getSongMv(albumAudioId: string | number, fields = 'mkv,tags,h264,h265,authors') {
  return request.get('/kmr/audio/mv', {
    params: {
      album_audio_id: albumAudioId,
      fields,
    },
  });
}

export function getVideoPrivilege(hash: string) {
  return request.get('/video/privilege', {
    params: { hash },
  });
}

export function getVideoDetail(id: string | number) {
  return request.get('/video/detail', {
    params: { id },
  });
}
