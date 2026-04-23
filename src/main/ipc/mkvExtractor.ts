import { ipcMain } from 'electron';
import { getMkvExtractorPort } from '../mkvExtractor';

export const registerMkvExtractorHandlers = () => {
  ipcMain.handle('mkv-extractor:port', () => {
    return getMkvExtractorPort();
  });
};
