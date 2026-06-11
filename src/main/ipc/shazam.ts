import { ipcRegistry } from './registry';
import { recognizeFromPCM } from '../shazam';
import type { RecognizeResponse } from '../../shared/shazam';

export const registerShazamHandlers = () => {
  ipcRegistry.registerHandler(
    'shazam:recognize',
    async (_event, pcmData: ArrayBuffer): Promise<RecognizeResponse> => {
      const buffer = Buffer.from(pcmData);
      return recognizeFromPCM(buffer);
    },
  );
};
