import request from '@/utils/request';
import { mapRecognizeMatches, type RecognizeMatch } from '@/utils/mappers';

/**
 * 听歌识曲
 * 将裸 PCM 音频（8000Hz / 16bit / 单声道 / s16le）提交到上游指纹识别接口
 * @param pcm 原始 PCM 数据
 * @returns 按置信度降序排列的匹配结果
 */
export async function recognizeAudio(pcm: ArrayBuffer): Promise<RecognizeMatch[]> {
  // 以 Uint8Array 形式提交：ArrayBuffer.isView 在 contextBridge 跨上下文场景下
  // 比 `instanceof ArrayBuffer` 更可靠，避免二进制 body 被 JSON 序列化破坏。
  const body = await request.post('/audio/match', new Uint8Array(pcm), {
    headers: { 'Content-Type': 'application/octet-stream' },
    params: { t: Date.now() },
  });

  const status = (body as { status?: number })?.status;
  const data = (body as { data?: unknown })?.data;
  if (status !== 1) return [];
  return mapRecognizeMatches(data);
}
