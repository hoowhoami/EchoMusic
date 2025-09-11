import { api } from '@/utils/request';

// 获取音乐详情
// 说明：调用此接口，可以获取音乐详情
// 必选参数：
// hash: 歌曲 hash, 可以传多个，每个以逗号分开
export const getSongPrivilege = (hash: string) => {
  return api.get('/privilege/lite', { hash });
};

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

// 获取歌曲 MV
// 说明 : 传入 album_audio_id/MixSongID 获取歌曲 相对应的 mv
// 必选参数：
// album_audio_id: 专辑音乐 id (album_audio_id/MixSongID 均可以), 可以传多个，每个以逗号分开,
// 可选参数：
// fields: 支持多个，每个以逗号分隔，支持的值有：mkv,tags,h264,h265,authors
export const getSongMv = (album_audio_id: number) => {
  return api.get('/kmr/audio/mv', { album_audio_id });
};
