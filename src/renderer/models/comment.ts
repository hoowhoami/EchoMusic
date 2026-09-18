export interface CommentLike {
  count: number;
}

export interface CommentBadgeChip {
  key: string;
  label: string;
  kind: string;
}

export interface Comment {
  id: string | number;
  userName: string;
  /** 评论作者酷狗 userid，批量查概念/畅听铭牌用 */
  userId?: string;
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
  /** IP 属地（如：广东），取自服务端 location 字段 */
  ipLocation?: string;
  /** 用户名旁 VIP / 身份徽标，由 commentVip 从 vip_type/m_type/y_type + vinfo9 解析 */
  badges?: CommentBadgeChip[];
  /** 达人 / 演唱者角标 URL（vinfo9.pic），叠在头像右下角 */
  talentIcon?: string;
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
