import { convertOpenccBatch } from '../opencc/native';
import { ipcRegistry } from './registry';

export const registerOpenccHandlers = () => {
  ipcRegistry.registerHandler(
    'opencc:convert-batch',
    (_event, payload: { texts?: unknown; profile?: unknown }) =>
      convertOpenccBatch(payload?.texts, payload?.profile),
  );
};
