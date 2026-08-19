export interface SongRelateGood {
  hash?: string;
  quality?: string;
  level?: number;
}

export type CloudAudioQualityValue = '128' | '320' | 'flac' | 'high';

export interface CloudAudioSource {
  cloudFileId?: string | number;
  hash: string;
  hashStd?: string;
  audioId?: string | number;
  albumAudioId?: string | number;
  bitrate?: number;
  quality?: CloudAudioQualityValue;
  size?: number;
  ext?: string;
  name?: string;
  matchBy?: 'albumAudioId' | 'audioId' | 'hashStd' | 'hash';
}

export interface SongArtist {
  id?: string | number;
  name: string;
  pic?: string;
}

export interface Song {
  id: string;
  songId?: string | number;
  title: string;
  name?: string;
  artist: string;
  language?: string;
  albumName?: string;
  artists?: SongArtist[];
  singers?: SongArtist[];
  album?: string;
  albumId?: string | number;
  duration: number;
  coverUrl: string;
  cover?: string;
  audioUrl: string;
  hash: string;
  /** 房间歌单用于翻页和同步定位的原始版权 hash。 */
  originalHash?: string;
  mvHash?: string;
  albumAudioId?: string | number;
  originalAlbumAudioId?: string | number;
  /** 众乐房授权：0=不可播，1=完整播放，2=仅片段。 */
  listenTogetherCanPlay?: number;
  /** 众乐房计费类型：1=免费，2/3=VIP，4/5/6=单曲或专辑付费。 */
  listenTogetherGenting?: number;
  mixSongId: string | number;
  fileId?: string | number;
  cloudFileId?: string | number;
  cloudAddedAt?: number;
  cloudSortOrder?: number;
  cloudAudioSource?: CloudAudioSource;
  source?: string;
  lyric?: string;
  lyricSnippet?: string;
  privilege?: number;
  payType?: number;
  oldCpy?: number;
  relateGoods?: SongRelateGood[];
  isOriginal?: boolean;
  recDesc?: string;
  similarDesc?: string;
  playCount?: number;
  lastPlayedAt?: number;
  historyKey?: string;
}
