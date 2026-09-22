import { toRecord } from '../../shared/object';

// 播放 hash、歌曲 album_audio_id 都不能用作 MV 收藏 ID。
export const normalizeVideoId = (value: unknown): string => {
  const text = String(value ?? '').trim();
  const id = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(id) && id > 0 ? String(id) : '';
};

export const assertVideoCollectionSuccess = (payload: unknown) => {
  const body = toRecord(payload);
  const code = body.error_code ?? body.errcode ?? body.err_code;
  if (
    (body.status !== undefined && Number(body.status) !== 1) ||
    (code !== undefined && Number(code) !== 0) ||
    (body.status === undefined && code === undefined)
  ) {
    throw new Error(String(body.msg || body.message || 'MV 收藏操作失败'));
  }
};
