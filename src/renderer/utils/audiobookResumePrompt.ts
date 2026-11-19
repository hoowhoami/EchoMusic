import { reactive } from 'vue';
import type { Song } from '@/models/song';

export type AudiobookPromptMode = 'differ' | 'same';

export interface ResumeScopeLike {
  kind?: string;
  id?: string | number | null;
  trackId?: string | number | null;
}

export interface AudiobookPromptState {
  open: boolean;
  mode: AudiobookPromptMode;
  /** 用户点播放的那一首（正在播的单曲） */
  songId: string;
  songName: string;
  /** 有声/长专专辑 id（续播桶 id） */
  albumId: string;
  /** 续播桶里记录的那一首 */
  scopeTrackId: string;
}

export const audiobookPromptState = reactive<AudiobookPromptState>({
  open: false,
  mode: 'differ',
  songId: '',
  songName: '',
  albumId: '',
  scopeTrackId: '',
});

// 详情页自己的播放队列（专辑/有声/长专/歌单/歌手）不弹；其它（搜索/历史/手动队列）都算单曲点播。
const DETAIL_QUEUE_PREFIXES = ['queue:album:', 'queue:playlist:', 'queue:artist:'];

const isDetailQueueId = (queueId?: string | null): boolean =>
  Boolean(queueId) &&
  DETAIL_QUEUE_PREFIXES.some((prefix) => (queueId as string).startsWith(prefix));

let pendingResumePlay: (() => void) | null = null;
let skipNextPrompt = false;

/**
 * 播放前检查：单曲点播（非详情页队列）且属于有声/长专（存在 audiobook 桶）时弹窗。
 * 返回 true 表示已弹窗、调用方应立即停止本次播放，等用户选择后再决定继续播或跳详情页。
 */
export const maybePromptAudiobookResume = (
  song: Song | null | undefined,
  queueId: string | null | undefined,
  resumeScopes: ReadonlyArray<ResumeScopeLike> = [],
  onResumePlay: () => void,
): boolean => {
  if (skipNextPrompt) {
    skipNextPrompt = false;
    return false;
  }
  if (!song) return false;
  if (isDetailQueueId(queueId)) return false;

  const albumId = String(song.albumId ?? '').trim();
  if (!albumId) return false;

  const scope = resumeScopes.find(
    (item) => item.kind === 'audiobook' && String(item.id ?? '') === albumId,
  );
  if (!scope) return false;

  const songId = String(song.id ?? '');
  const scopeTrackId = String(scope.trackId ?? '');
  audiobookPromptState.songId = songId;
  audiobookPromptState.songName = String(song.name ?? '');
  audiobookPromptState.albumId = albumId;
  audiobookPromptState.scopeTrackId = scopeTrackId;
  audiobookPromptState.mode = scopeTrackId && scopeTrackId !== songId ? 'differ' : 'same';
  audiobookPromptState.open = true;
  pendingResumePlay = onResumePlay;
  return true;
};

/** 否：不跳转，继续播放当前这首。 */
export const cancelAudiobookResumePrompt = (): void => {
  const resumePlay = pendingResumePlay;
  pendingResumePlay = null;
  audiobookPromptState.open = false;
  if (resumePlay) {
    skipNextPrompt = true;
    resumePlay();
  }
};

/** 是：跳去上次播放（路由跳转由组件负责），不再继续播放。 */
export const confirmAudiobookResumePrompt = (): void => {
  pendingResumePlay = null;
  audiobookPromptState.open = false;
};
