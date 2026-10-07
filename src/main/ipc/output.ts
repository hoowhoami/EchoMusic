import { ipcRegistry } from './registry';
import { getOutputHost } from '../outputs/outputHost';
import { rescanDlnaDevices, syncOutputScan } from '../outputs/outputRuntime';
import type { HostTrackMeta } from '../outputs/outputHost';

function host() {
  const current = getOutputHost();
  if (!current) throw new Error('输出会话尚未初始化');
  return current;
}

export function registerOutputIpc(): void {
  ipcRegistry.registerHandler('output:list-targets', () => host().targets());
  ipcRegistry.registerHandler('output:refresh', async () => {
    // 不要先调 `syncOutputScan()`：它会在空闲时启动完整的 7 秒周期，刷新就
    // 要先等完三轮再补一轮。`rescanDlnaDevices` 只需一轮，自己管扫描状态。
    await rescanDlnaDevices();
    return host().refresh();
  });
  ipcRegistry.registerHandler('output:connect', async (_event, targetId: string, pin?: string) => {
    return host().connect(String(targetId ?? ''), typeof pin === 'string' ? pin : undefined);
  });
  ipcRegistry.registerHandler('output:disconnect', async () => {
    await host().activateLocal('user');
    syncOutputScan();
    return host().sessionView();
  });
  ipcRegistry.registerHandler('output:set-enabled', (_event, enabled: boolean) => {
    host().setEnabled(Boolean(enabled));
    syncOutputScan();
    return host().sessionView();
  });
  ipcRegistry.registerHandler('output:set-browsing', (_event, open: boolean) => {
    host().setBrowsing(Boolean(open));
    syncOutputScan();
    return host().wantsScan;
  });
  ipcRegistry.registerHandler('output:set-track-meta', (_event, meta: HostTrackMeta) => {
    if (!meta || typeof meta !== 'object') return;
    host().setTrackMeta({
      title: typeof meta.title === 'string' ? meta.title : undefined,
      artist: typeof meta.artist === 'string' ? meta.artist : undefined,
      album: typeof meta.album === 'string' ? meta.album : undefined,
      artwork: typeof meta.artwork === 'string' ? meta.artwork : undefined,
      durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : undefined,
      mime: typeof meta.mime === 'string' ? meta.mime : undefined,
      headers:
        meta.headers && typeof meta.headers === 'object'
          ? Object.fromEntries(
              Object.entries(meta.headers).filter(
                (entry): entry is [string, string] =>
                  typeof entry[0] === 'string' && typeof entry[1] === 'string',
              ),
            )
          : undefined,
    });
  });
  ipcRegistry.registerHandler('output:get-session', () => host().sessionView());
  ipcRegistry.registerHandler('output:clear-records', async () => {
    await host().clearRecords();
    return host().sessionView();
  });
}
