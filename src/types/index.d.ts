// Playlist
export type Playlist = {
  tags: string;
  status: number;
  create_user_pic: string;
  is_pri: number;
  pub_new: number;
  is_drop: number;
  list_create_userid: number;
  is_publish: number;
  musiclib_tags: any[]; // 空数组，可根据实际数据类型细化
  pub_type: number;
  is_featured: number;
  publish_date: string; // 日期格式
  collect_total: number;
  list_ver: number;
  intro: string;
  type: number;
  list_create_listid: number;
  radio_id: number;
  source: number;
  listid: number;
  is_def: number;
  parent_global_collection_id: string;
  sound_quality: string;
  per_count: number;
  plist: any[]; // 空数组，可根据实际数据类型细化
  kq_talent: number;
  create_time: number; // 时间戳
  is_per: number;
  is_edit: number;
  update_time: number; // 时间戳
  code: number;
  count: number;
  sort: number;
  is_mine: number;
  musiclib_id: number;
  per_num: number;
  create_user_gender: number;
  number: number;
  pic: string;
  list_create_username: string;
  name: string;
  is_custom_pic: number;
  global_collection_id: string;
  heat: number;
  list_create_gid: string;
  authors?: string;
  play_count?: number;
};

// Song
export type Song = {
  mvdata: Array<{
    typ: number;
  }>;
  hash: string;
  brief: string;
  audio_id: number;
  mvtype: number;
  size: number;
  publish_date: string;
  name: string;
  mvtrack: number;
  bpm_type: string;
  add_mixsongid: number;
  album_id: string;
  bpm: number;
  mvhash: string;
  extname: string;
  language: string;
  collecttime: number;
  csong: number;
  remark: string;
  level: number;
  tagmap: {
    genre0: number;
  };
  media_old_cpy: number;
  relate_goods: Array<{
    size: number;
    hash: string;
    level: number;
    privilege: number;
    bitrate: number;
  }>;
  download: Array<{
    status: number;
    hash: string;
    fail_process: number;
    pay_type: number;
  }>;
  rcflag: number;
  feetype: number;
  has_obbligato: number;
  timelen: number;
  sort: number;
  trans_param: {
    ogg_128_hash: string;
    union_cover: string;
    language: string;
    cpy_attr0: number;
    musicpack_advance: number;
    display: number;
    display_rate: number;
    ogg_320_filesize: number;
    cpy_grade: number;
    qualitymap: {
      attr0: number;
      attr1: number;
    };
    hash_multitrack: string;
    songname_suffix: string;
    cid: number;
    ogg_128_filesize: number;
    classmap: {
      attr0: number;
    };
    ogg_320_hash: string;
    hash_offset: {
      clip_hash: string;
      start_byte: number;
      file_type: number;
      end_byte: number;
      end_ms: number;
      start_ms: number;
      offset_hash: string;
    };
    pay_block_tpl: number;
    ipmap: {
      attr0: number;
    };
    cpy_level: number;
  };
  medistype: string;
  user_id: number;
  albuminfo: {
    name: string;
    id: number;
    publish: number;
  };
  bitrate: number;
  audio_group_id: string;
  privilege: number;
  cover: string;
  mixsongid: number;
  fileid: number;
  heat: number;
  singerinfo: Array<{
    id: number;
    publish: number;
    name: string;
    avatar: string;
    type: number;
  }>;
  album_audio_id: number;
  source: 'cloud' | undefined;
};

// Album
export type Album = {
  albumid: number;
  albumname: string;
  singer: string;
  singerid: string;
  grade: number;
  grade_int: string;
  img: string;
  intro: string;
  grade_float: string;
  company: string;
  quality: number;
  title: string;
  collect_count: number;
  publish_time: string;
  language: string;
  privilege: number;
  oldhide: number;
  buyercount: number;
  songcount: number;
  newquality: number;
  cd_url: string;
  isfirst: number;
  category: number;
  short_intro: string;
  ostremark: string;
  auxiliary: string;
  play_times: number;
  program_inner: number;
  alg_path: string;
  program_def_songs: [];
  tag_str: string;
  album_aux: string;
  play_count: number;
  isouter: number;
  outerdata: any;
  trans_param: any;
  singerids: number[];
  singers: Array<{
    id: number;
    name: string;
  }>;
  heat: number;
  type: string;
};

// Singer
export type Singer = {
  albumcount: number;
  descibe: string; // 注意：原字段可能是"describe"的拼写，这里保持与JSON一致
  offline_url: string;
  heatoffset: number;
  singerid: number;
  songcount: number;
  fanscount: number;
  singername: string;
  is_settled: number;
  intro: string;
  mvcount: number;
  url: string;
  sortoffset: number;
  heat: number;
  imgurl: string;
  birthday: string;
  source: number;
};

// PlayMode
export type PlayMode = 'repeat' | 'repeat-once' | 'shuffle';

// Song climax
export type SongClimax = {
  start_time: number;
  end_time: number;
  timelength: number;
  author_name: string;
  hash: string;
  audio_id: string;
  audio_name: string;
};

// Song quality
export type MusicEffect =
  | 'piano' // 钢琴音效，仅部分音乐支持
  | 'acappella' // 人声伴奏模式，仅部分音乐支持，返回mkv格式（含人声和伴奏两个音轨）
  | 'subwoofer' // 骨笛音效，仅部分音乐支持
  | 'ancient' // 尤克里里音效，仅部分音乐支持
  | 'surnay' // 唢呐音效，仅部分音乐支持
  | 'dj' // DJ音效，仅部分音乐支持
  | 'viper_clear' // 蝰蛇超清音质
  | 'viper_tape' //蝰蛇母带
  | 'viper_atmos'; // 蝰蛇全景声，仅部分音乐支持

export type AudioQuality =
  | '128' // 128码率MP3格式
  | '320' // 320码率MP3格式
  | 'flac'; // FLAC格式音频

/**
 * 音乐转换参数类型
 * 组合音效类型和音频质量的联合类型
 */
export type SongQuality = MusicEffect | AudioQuality;

/**
 * 音质选项配置
 */
export type QualityOption = {
  label: string;
  value: AudioQuality | MusicEffect;
};

export type QualityOptionGroup = {
  label: string;
  key: string;
  type: 'group';
  children: QualityOption[];
  // 添加 naive-ui SelectGroupOption 需要的属性
  [key: string]: any;
};

export type QualitySelectOption = QualityOptionGroup;

// VIP领取
export type VipReceive = {
  remain_vip_hour: number;
  total: number;
  done: number;
  remain: number;
  award_vip_hour: number;
  day: number;
};

// 歌词相关类型定义
export type LyricsCharacter = {
  char: string;
  startTime: number;
  endTime: number;
  highlighted: boolean;
};

export type LyricsLine = {
  characters: LyricsCharacter[];
  translated?: string;
  romanized?: string;
};

export type LyricsMode = 'translation' | 'romanization';

// Rank
export type Rank = {
  album_cover_color: string;
  album_img_9: string;
  banner7url: string;
  banner_9: string;
  bannerurl: string;
  base_img: string;
  children: any[]; // 空数组，可根据实际子元素类型具体化
  classify: number;
  count_down: number;
  custom_type: number;
  extra: any;
  haschildren: number;
  id: number;
  img_9: string;
  img_cover: string;
  imgurl: string;
  intro: string;
  is_timing: number;
  issue: number;
  isvol: number;
  jump_title: string;
  jump_url: string;
  new_cycle: number;
  play_times: number;
  rank_cid: number;
  rank_id_publish_date: string;
  rankid: number;
  rankname: string;
  ranktype: number;
  share_bg: string;
  share_logo: string;
  show_play_button: number;
  show_play_count: number;
  songinfo: any;
  table_plaque: string;
  update_frequency: string;
  update_frequency_type: number;
  video_ending: string;
  zone: string;
};

// Playlist Tag
export type PlaylistTag = {
  parent_id: string;
  son: PlaylistTag[];
  sort: string;
  tag_id: string;
  tag_name: string;
};

// MV
export type MV = {
  album_audio_id: number;
  audio_id: number;
  collection_total: number;
  desc: string;
  download_total: number;
  duration: number;
  have_mp4: number;
  hdpic: string;
  hit: number;
  hot: number;
  is_other: number;
  is_publish: number;
  is_recommend: number;
  is_short: number;
  is_ugc: number;
  music_trac: number;
  mv_name: string;
  other_desc: string;
  play_times: number;
  publish_time: string;
  remark: string;
  singer: string;
  songid: number;
  thumb: string;
  topic: string;
  type: number;
  user_avatar: string;
  user_id: number;
  user_name: string;
  video_id: number;
  __status: number;
  cover: string;
  intro: string;
  other_description: string;
};

// IP
export type IP = {
  extra: IPExtraInfo;
  id: number;
  image_shape: number;
  image_url: string;
  position: number;
  sizable_image_url: string;
  sub_title: string;
  subscript: number;
  title: string;
  type: number;
};

export type IPExtraInfo = {
  play_count: number;
  specialid: number;
  global_collection_id: string;
  global_special_id: string;
  suid: number;
};
