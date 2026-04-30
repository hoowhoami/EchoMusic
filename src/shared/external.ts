/** 外部歌单导入相关共享类型 */

export type ExternalProviderId = 'netease' | 'qqmusic' | 'kuwo' | 'kugou' | 'text' | 'auto';

export interface ExternalTrack {
  /** 原平台的 track id（可选，仅做调试） */
  externalId?: string;
  /** 歌曲标题（已清理） */
  title: string;
  /** 主要艺人名（多个用 / 分隔，匹配时会拆分） */
  artist: string;
  /** 专辑名（可选） */
  album?: string;
  /** 时长（秒，可选） */
  duration?: number;
}

export interface ExternalPlaylist {
  /** 来源 provider */
  provider: ExternalProviderId;
  /** 原平台歌单 id（可选） */
  externalId?: string;
  /** 歌单名 */
  name: string;
  /** 歌单描述 */
  description?: string;
  /** 封面图 URL */
  coverUrl?: string;
  /** 创建者 */
  creator?: string;
  /** 歌曲列表 */
  tracks: ExternalTrack[];
}

export interface ResolvePlaylistRequest {
  /** 用户输入：可以是链接、纯 ID 或一段文本（text provider） */
  input: string;
  /** 强制使用某个 provider，'auto' 表示从输入中嗅探 */
  provider?: ExternalProviderId;
}

export type ResolvePlaylistResponse =
  | {
      ok: true;
      playlist: ExternalPlaylist;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };
