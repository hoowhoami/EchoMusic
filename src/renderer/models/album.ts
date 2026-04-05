export interface Album {
  id: number;
  name: string;
  pic: string;
  intro: string;
  singerName: string;
  singerId: number;
  publishTime: string;
  songCount: number;
  playCount: number;
  heat: number;
  language: string;
  type: string;
  company: string;

  albumid?: number;
  album_id?: number;
  albumname?: string;
  album_name?: string;
  imgurl?: string;
  sizable_cover?: string;
  singername?: string;
  singerid?: number;
  publishtime?: string;
  songcount?: number;
  playcount?: number;
  collectcount?: number;
}

export type AlbumMeta = Album;
