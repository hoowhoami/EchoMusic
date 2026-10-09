import type { Song } from '@/models/song';

export type PlaybackQueueType =
  | 'default'
  | 'daily-recommend'
  | 'home-discover'
  | 'style-recommend'
  | 'playlist'
  | 'ranking'
  | 'album'
  | 'artist'
  | 'search'
  | 'history'
  | 'cloud'
  | 'fm'
  | 'listen-together'
  | 'manual'
  | 'purchased'
  | 'free-listen';

export type PersonalFmMode = 'normal' | 'small' | 'peak' | 'radio';
export type PersonalFmSongPoolId = 0 | 1 | 2;
export type PersonalFmAction =
  | 'play'
  | 'login'
  | 'garbage'
  | 'cancel_garbage'
  | 'click_red'
  | 'cancel_red'
  | 'download'
  | 'black_singer'
  | 'cancel_black_singer'
  | 'update_recommend_source'
  | 'change_song_pool';

export interface PlaybackQueueMetaValueMap {
  [key: string]: string | number | boolean | null | undefined;
}

export interface PlaybackQueueState {
  id: string;
  /** 队列的具体名称，所有展示入口一致使用。 */
  title: string;
  /** 可选来源信息，如专辑歌手、歌单创建者、搜索关键词；不存类别或推荐文案。 */
  subtitle: string;
  coverUrl: string;
  type: PlaybackQueueType;
  songs: Song[];
  songCount?: number;
  filteredInvalidCount: number;
  queuedNextTrackIds: string[];
  currentTrackId: string | null;
  /** Runtime-only revision for changes that can alter the next playback decision. */
  playbackRevision?: number;
  createdAt: number;
  updatedAt: number;
  dynamic: boolean;
  meta: PlaybackQueueMetaValueMap;
}

export interface SetPlaybackQueueOptions {
  queueId?: string;
  /** 队列名称，不使用“当前 / 历史”等运行状态。 */
  title?: string;
  /** 真实来源信息；没有时传空字符串以清除旧信息。 */
  subtitle?: string;
  coverUrl?: string;
  type?: PlaybackQueueType;
  dynamic?: boolean;
  meta?: PlaybackQueueMetaValueMap;
  activate?: boolean;
  /** Keep the explicit play-next group while its songs are being repositioned in this queue. */
  preserveQueuedNext?: boolean;
}
