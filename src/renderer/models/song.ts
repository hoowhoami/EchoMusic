export interface SongRelateGood {
  hash?: string;
  quality?: string;
  level?: number;
}

export interface SongArtist {
  id?: string | number;
  name: string;
}

export interface Song {
  id: string;
  title: string;
  name?: string;
  artist: string;
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
  mvHash?: string;
  mixSongId: string | number;
  fileId?: string | number;
  source?: string;
  lyric?: string;
  privilege?: number;
  payType?: number;
  oldCpy?: number;
  relateGoods?: SongRelateGood[];
  playCount?: number;
  lastPlayedAt?: number;
  historyKey?: string;
}
