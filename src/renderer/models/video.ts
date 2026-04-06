export interface VideoAuthor {
  id?: string | number;
  name: string;
  avatar?: string;
}

export interface VideoTag {
  id?: string | number;
  name: string;
}

export interface VideoSource {
  hash: string;
  url: string;
  label: string;
  codec?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  size?: number;
}

export interface VideoMeta {
  id: string;
  hash: string;
  title: string;
  description?: string;
  coverUrl: string;
  duration: number;
  playCount?: number;
  publishTime?: number;
  albumAudioId?: string | number;
  songName?: string;
  artistName?: string;
  albumName?: string;
  authors?: VideoAuthor[];
  tags?: VideoTag[];
  sources?: VideoSource[];
  collectionCount?: number;
  downloadCount?: number;
  recommend?: boolean;
  raw?: Record<string, unknown>;
}
