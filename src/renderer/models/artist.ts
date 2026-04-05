export interface Artist {
  id: number;
  name: string;
  pic: string;
  intro: string;
  songCount: number;
  albumCount: number;
  mvCount: number;
  fansCount: number;
  isFollowed?: boolean;

  singerid?: number;
  author_id?: number;
  singername?: string;
  author_name?: string;
  imgurl?: string;
  avatar?: string;
  songcount?: number;
  albumcount?: number;
  mvcount?: number;
  fanscount?: number;
}

export type ArtistMeta = Artist;
