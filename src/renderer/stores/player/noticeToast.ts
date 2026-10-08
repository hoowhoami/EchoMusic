import { watch } from 'vue';
import type { PlayerState } from './state';
import type { useToastStore } from '../toast';
import { resolvePlaybackFailureDetail } from './noticeDetails';

type NoticeState = Pick<
  PlayerState,
  'playbackNotice' | 'playbackRequestSeq' | 'currentTrackSnapshot' | 'autoNextTimer'
>;

/** 在播放器单例中监听，避免播放栏和播放页各弹一次，也不在重新打开页面时重播旧错误。 */
export function watchPlaybackNoticeToasts(
  state: NoticeState,
  toast: Pick<ReturnType<typeof useToastStore>, 'standard'>,
) {
  let lastKey = '';
  return watch(
    () => state.playbackNotice,
    (notice) => {
      if (!notice) {
        lastKey = '';
        return;
      }
      if (notice.code.startsWith('audio-effect-')) return;
      const key = JSON.stringify([
        state.playbackRequestSeq,
        notice.trackId,
        notice.code,
        notice.reason,
      ]);
      if (key === lastKey) return;
      lastKey = key;

      const track = state.currentTrackSnapshot;
      const trackName =
        notice.trackId && track && String(track.id) === notice.trackId
          ? String(track.name ?? '').trim()
          : '';
      const title = trackName ? `${notice.title} · ${trackName}` : notice.title;
      // 只有已安排自动切歌时才显示倒计时，保留设备错误等独立的处理建议。
      const detail =
        notice.detail.includes('尝试下一首') && state.autoNextTimer === null
          ? resolvePlaybackFailureDetail(notice.reason)
          : notice.detail;
      toast.standard(
        [notice.reason, detail].filter(Boolean).join('\n'),
        'danger',
        6000,
        undefined,
        title,
      );
    },
    // 等本轮错误处理结束，读取实际安排的自动切歌；瞬间清除的临时错误不弹提示。
    { flush: 'post' },
  );
}
