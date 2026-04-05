export interface CommentLike {
  count: number;
}

export interface Comment {
  id: string | number;
  userName: string;
  userPic?: string;
  avatar: string;
  content: string;
  time: string;
  addTime?: string;
  likeCount: number;
  like?: CommentLike;
  replyCount?: number;
  replyNum?: number;
  isHot?: boolean;
  isStar?: boolean;
  raw?: Record<string, unknown>;
  specialId?: string;
  specialChildId?: string;
  tid?: string;
  code?: string;
  mixSongId?: string;
  mixsongid?: string;

  comment_id?: string | number;
  user_name?: string;
  user_pic?: string;
  addtime?: string;
  like_count?: number;
  reply_num?: number;
  special_id?: string;
  special_child_id?: string;
  audio_id?: string;
  album_audio_id?: string;
}
