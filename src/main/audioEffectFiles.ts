import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const createImportedAudioEffectId = async (filePath: string): Promise<string> => {
  const contentHash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) contentHash.update(chunk);
  return `local-ir-${contentHash.digest('hex')}`;
};
