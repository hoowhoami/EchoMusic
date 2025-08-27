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
};

// 排序选项
export const sortOptions = {
  default: { name: '默认排序', show: 'all', icon: 'Sort' },
  titleAZ: { name: '标题升序（ A - Z ）', show: 'all', icon: 'SortAZ' },
  titleZA: { name: '标题降序（ Z - A ）', show: 'all', icon: 'SortZA' },
  arAZ: { name: '歌手升序（ A - Z ）', show: 'song', icon: 'SortAZ' },
  arZA: { name: '歌手降序（ Z - A ）', show: 'song', icon: 'SortZA' },
  timeUp: { name: '时长升序', show: 'all', icon: 'SortClockUp' },
  timeDown: { name: '时长降序', show: 'all', icon: 'SortClockDown' },
  dateUp: { name: '日期升序', show: 'radio', icon: 'SortDateUp' },
  dateDown: { name: '日期降序', show: 'radio', icon: 'SortDateDown' },
} as const;

// sort
export type Sort = keyof typeof sortOptions;
