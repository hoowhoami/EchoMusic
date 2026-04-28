/** 听歌识曲 IPC 注册 */

import { ipcMain } from 'electron';
import { recognizeFromPCM } from '../shazam';
import type { RecognizeResponse } from '../../shared/shazam';

export const registerShazamHandlers = () => {
  // 接收渲染进程传来的 PCM 音频数据进行识别
  ipcMain.handle(
    'shazam:recognize',
    async (_event, pcmData: ArrayBuffer): Promise<RecognizeResponse> => {
      const buffer = Buffer.from(pcmData);
      return recognizeFromPCM(buffer);
    },
  );
};
