import type { Song } from './song';

export type ListenTogetherSessionPhase =
  | 'idle'
  | 'joining'
  | 'creating'
  | 'joined'
  | 'leaving'
  | 'error';

export type ListenTogetherRoomType = 0 | 1;
export type ListenTogetherStudyRoomKind = 'official' | 'community';
export type ListenTogetherRoomBiz = '1000' | '1009';
export type ListenTogetherRoomPrivacy = 1 | 2;

export const getListenTogetherRoomBiz = (
  roomType: ListenTogetherRoomType,
): ListenTogetherRoomBiz => (roomType === 1 ? '1000' : '1009');

export interface ListenTogetherTag {
  id: string;
  name: string;
}

export interface ListenTogetherMemberPreview {
  userId: string;
  nickname: string;
  avatarUrl: string;
  studyStatus?: number;
}

export interface ListenTogetherRoom {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerAvatarUrl: string;
  /** 酷狗房间大类：0=众乐房，1=自习室。 */
  roomType: ListenTogetherRoomType;
  /** 学习房体系内部类型：官方自习室或用户创建的主题自习室。 */
  studyRoomKind?: ListenTogetherStudyRoomKind;
  memberCount: number;
  memberLimit?: number;
  studyCount: number;
  allowChat: boolean;
  channelId: string;
  channelName: string;
  currentSongName: string;
  currentArtistName: string;
  notice: string;
  musicType?: number;
  whiteNoiseType?: number;
  /** 自习室详情接口返回的原始房间标签 ID，多个值以逗号分隔。 */
  roomTag?: string;
  /** 自习室详情接口返回的原始音乐风格 ID，多个值以逗号分隔。 */
  musicStyle?: string;
  /** 上游已隐藏或已经结束的房间，不应继续出现在可加入列表。 */
  closed: boolean;
  closeReason: string;
  tags: ListenTogetherTag[];
  musicStyles: ListenTogetherTag[];
  memberPreviews: ListenTogetherMemberPreview[];
  audios: ListenTogetherAudioRef[];
}

export interface ListenTogetherAudioRef {
  hash: string;
  mixSongId: string | number;
}

export interface ListenTogetherMusicProgressInfo {
  hash: string;
  album_audio_id: string | number;
  progress: number;
  pause: 1 | 2;
  play_mode: '1' | '2' | '3';
}

export interface ListenTogetherMember extends ListenTogetherMemberPreview {
  studyTime: number;
  /** 概念版成员分类：1=学习中，2=围观。 */
  memberType?: 1 | 2;
}

export interface ListenTogetherMessage {
  id: string;
  userId: string;
  nickname: string;
  avatarUrl: string;
  type: number;
  text: string;
  sentAt: number;
  online: boolean;
  system: boolean;
}

export interface ListenTogetherRemotePlayback {
  hash: string;
  mixSongId: string | number;
  position: number;
  playing: boolean;
  updatedAt: number;
}

export interface ListenTogetherSongOrder {
  id: string;
  song: Song;
  requesterId: string;
  requesterName: string;
  requesterAvatarUrl: string;
}

export interface ListenTogetherChannel {
  id: string;
  name: string;
  coverUrl: string;
  songCount: number;
  subscriberCount: number;
  tags: ListenTogetherTag[];
}

interface ListenTogetherCreateBase {
  name: string;
  notice: string;
  audios: ListenTogetherAudioRef[];
}

export interface ListenTogetherStudyRoomCreateInput extends ListenTogetherCreateBase {
  roomType: 1;
  channelId: string;
  musicStyles: string[];
  allowChat: boolean;
  roomTag?: string;
}

export interface ListenTogetherMusicRoomCreateInput extends ListenTogetherCreateBase {
  roomType: 0;
  privacy: ListenTogetherRoomPrivacy;
  capacity?: number;
  backgroundUrl?: string;
  progressInfo?: ListenTogetherMusicProgressInfo;
}

export type ListenTogetherCreateInput =
  | ListenTogetherStudyRoomCreateInput
  | ListenTogetherMusicRoomCreateInput;

export type ListenTogetherSong = Song;
