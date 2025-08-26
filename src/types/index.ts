// Playlist
export type Playlist = {
  id: string;
  name: string;
  list_create_userid: number;
  global_collection_id: string;
  pic: string;
  authors?: number;
  sort: number;
};

// Song
export type Song = {
  id: number;
  name: string;
  pic: string;
  author: string;
  album: string;
  duration: number;
  url: string;
};
