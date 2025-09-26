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
export const getSongUrl = (hash: string, quality: string = '', free_part = '') => {
  return api.get('/song/url', {
    hash,
    quality,
    free_part,
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
export const getSongMV = (album_audio_id: number) => {
  return api.get('/kmr/audio/mv', { album_audio_id });
};

// 获取视频详情
// 说明：调用此接口，可以获取视频详情，可以获取更高清的视频 hash
// 必选参数：
// id: 视频 id/video id
export const getSongMVDetail = (id: number) => {
  return api.get('/video/detail', { id });
};

// 获取视频 url
// 说明 : 传入的视频的 hash, 可以获取对应的视频的 url
// 必选参数：
// hash: 视频 hash
export const getVideoUrl = (hash: string) => {
  return api.get('/video/url', { hash });
};

// 歌词搜索
// 说明: 调用此接口, 可以搜索歌词，该接口需配合 /lyric 使用。
// 必选参数：
// keyword: 关键词，与 hash 二选一
// hash: 歌曲 hash，与 keyword 二选一
// 可选参数：
// album_audio_id: 专辑音乐 id,
// man: 是否返回多个歌词，yes：返回多个， no：返回一个。 默认为no
export const searchLyric = ({ keyword = '', hash = '' }) => {
  return api.get('/search/lyric', { keyword, hash });
};

// 获取歌词
// 说明 : 调用此接口，可以获取歌词，调用该接口前则需要调用/search/lyric 获取完整参数
// 必选参数：
// id: 歌词 id, 可以从 /search/lyric 接口中获取
// accesskey: 歌词 accesskey, 可以从 /search/lyric 接口中获取
// 可选参数：
// fmt: 歌词类型，lrc 为普通歌词，krc 为逐字歌词
// decode: 是否解码，传入该参数这返回解码后的歌词
export const getLyric = ({ id = '', accesskey = '', fmt = 'lrc', decode = 'true' }) => {
  return api.get('/lyric', { id, accesskey, fmt, decode });
};

// 新歌速递
// 说明：调用此接口，可以获取新歌速递
export const getSongTop = () => {
  return api.get('/top/song');
};
