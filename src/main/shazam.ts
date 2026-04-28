/** 主进程 Shazam 识别服务 */

import { Shazam, s16LEToSamplesArray } from 'shazam-api';
import log from './logger';
import type { RecognizeResponse } from '../shared/shazam';

const shazam = new Shazam();

/**
 * 识别 PCM 音频数据
 * @param pcmBuffer 原始 PCM 数据（16000Hz, 16bit, 单声道, s16le）
 */
export async function recognizeFromPCM(pcmBuffer: Buffer): Promise<RecognizeResponse> {
  try {
    log.info('[Shazam] Recognizing audio, size:', pcmBuffer.length, 'bytes');

    const samples = s16LEToSamplesArray(pcmBuffer);
    const songData = await shazam.fullRecognizeSong(samples);

    if (!songData?.track) {
      log.info('[Shazam] No match found');
      return { success: false, error: '未识别到歌曲，请靠近音源重试' };
    }

    const track = songData.track;
    const albumMeta = track.sections
      ?.flatMap((s) => s.metadata ?? [])
      ?.find((m) => m.title === 'Album');

    const result = {
      title: track.title || '',
      artist: track.subtitle || '',
      album: albumMeta?.text,
      coverUrl: track.images?.coverarthq || track.images?.coverart || track.images?.background,
      shazamUrl: track.url,
    };

    log.info('[Shazam] Match found:', result.title, '-', result.artist);
    return { success: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('[Shazam] Recognition failed:', message);
    return { success: false, error: `识别失败: ${message}` };
  }
}
