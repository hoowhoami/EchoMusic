import { api } from '@/utils/request';

// 获取音乐 URL
// hash: 音乐 hash
// album_id: 专辑 id
// free_part: 是否返回试听部分（仅部分歌曲）
// album_audio_id：专辑音频 id
// quality：获取不同音质的 url
export const getSongUrl = (hash: string, quality: string = '') => {
  return api.get('/song/url', {
    hash,
    quality,
  });
};

// 获取歌曲高潮部分
// hash: 音乐 hash, 可以传多个，以逗号分割
export const getSongClimax = (hash: string) => {
  return api.get('/song/climax', { hash });
};
