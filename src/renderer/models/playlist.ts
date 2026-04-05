import type { Song } from './song';

export interface Playlist {
  id: number;
  globalCollectionId?: string;
  listCreateGid?: string;
  listCreateUserid?: number;
  listCreateListid?: number;
  listid?: number;
  musiclibId?: number;
  ipId?: number;
  name: string;
  pic: string;
  intro: string;
  nickname: string;
  userPic: string;
  tags: string;
  playCount: number;
  count: number;
  songs?: Song[];
  isPrivate: boolean;
  heat?: number;
  publishDate?: string;
  createTime?: number;
  updateTime?: number;
  source: number;
  type?: number;
  isDefault?: boolean;
  originalId?: number;

  specialid?: number;
  specialname?: string;
  imgurl?: string;
  playcount?: number;
  songcount?: number;
  collectcount?: number;
  publishtime?: string;
  create_user_pic?: string;
  list_create_username?: string;
}

export type PlaylistMeta = Playlist;

export interface PlaylistInfo {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  userId: number;
  isDefault?: boolean;
  type?: number;
  source?: number;
}
