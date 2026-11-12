/**
 * 听歌统计快照计算。
 *
 * 逐行移植自 EchoMusicNext `HistoryService.cpp` 的 `buildStats()`（117-302 行），
 * 统计口径完全对齐：每首歌只按「最后播放」的日期/时刻计入足迹，
 * 绝不伪造事件时间线。
 *
 * 「已记录时长」在 Next 侧取本地结算收听毫秒（listened_ms）；本项目本地
 * 历史没有该字段，按约定恒为占位值「0 分钟」，不做时长估算。
 */

/** 计算所需的播放历史条目结构（与 renderer 的 LocalHistoryEntry 结构兼容） */
export interface HistoryStatsEntrySong {
  id?: number | string;
  fileId?: number | string;
  mixSongId?: number | string;
  name?: string;
  artist?: string;
  artists?: Array<{ name?: string }>;
  singers?: Array<{ name?: string }>;
  albumName?: string;
  album?: string;
  coverUrl?: string;
  cover?: string;
}

export interface HistoryStatsEntry {
  song: HistoryStatsEntrySong;
  /** 最后播放时间戳（ms） */
  lastPlayedAt: number;
  /** 本地累计播放次数 */
  playCount: number;
  /** 去重键 */
  historyKey: string;
}

export interface HistoryStatCard {
  label: string;
  value: string;
  unit: string;
  caption: string;
}

export interface HistoryCalendarDay {
  /** 日号（月内第几天） */
  day: number;
  /** yyyy-MM-dd */
  date: string;
  count: number;
  /** count / 35 天窗口内最大值 */
  ratio: number;
  today: boolean;
  future: boolean;
}

export interface HistoryHourFootprint {
  hour: number;
  count: number;
  /** count / 24 小时内最大值 */
  ratio: number;
}

export interface HistoryTopArtist {
  name: string;
  songs: number;
  plays: number;
  ratio: number;
}

export interface HistoryTopAlbum {
  name: string;
  cover: string;
  plays: number;
  songs: number;
}

export interface HistoryTopSong {
  key: string;
  id: string;
  title: string;
  artist: string;
  cover: string;
  plays: number;
  lastPlayedLabel: string;
}

export interface HistoryStats {
  totalSongs: number;
  totalPlays: number;
  totalPlaysLabel: string;
  listenedMs: number;
  statCards: HistoryStatCard[];
  topArtists: HistoryTopArtist[];
  topAlbum: HistoryTopAlbum;
  topSongs: HistoryTopSong[];
  calendarDays: HistoryCalendarDay[];
  calendarSongs: number;
  calendarLabel: string;
  hourlyFootprint: HistoryHourFootprint[];
  peakHourLabel: string;
  replayPercent: number;
  datedSongs: number;
  dateRangeLabel: string;
  latestPlayedLabel: string;
}

const UNKNOWN_ARTIST = '未知歌手';
const UNKNOWN_ALBUM = '未知专辑';
const UNKNOWN_SONG = '未知歌曲';
const CALENDAR_DAY_COUNT = 35;

const compact = (value: number) => new Intl.NumberFormat('zh-CN').format(value);

/** 结算收听时长的展示文案；分钟 <60、小时 <100、天封顶，>10 时取整 */
const listenDuration = (seconds: number) => {
  if (seconds <= 0) return '0 分钟';
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = seconds / 3600;
  if (hours < 100) return `${hours >= 10 ? hours.toFixed(0) : hours.toFixed(1)} 小时`;
  const days = hours / 24;
  return `${days >= 10 ? days.toFixed(0) : days.toFixed(1)} 天`;
};

/** 「M月D日 HH:mm」；时间戳无效时显示「未知」 */
const playDate = (timestamp: number | undefined) => {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '未知';
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
};

const formatDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const formatShortDate = (date: Date) =>
  `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;

/** yyyy.MM.dd */
const formatRangeDate = (timestamp: number) => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
};

/** 歌手名解析：结构化字段优先，否则按分隔符切分原始串（对齐 Next artistNames） */
const artistNames = (song: HistoryStatsEntrySong): string[] => {
  const names: string[] = [];
  // 本项目 mapper 会在同一歌曲对象上把 artists/singers 设为同一数组，
  // 拼接后必须按名去重，否则每位歌手的 plays/songs 被双倍计入
  const seen = new Set<string>();
  for (const ref of [...(song.artists ?? []), ...(song.singers ?? [])]) {
    const name = ref.name?.trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  if (names.length > 0) return names;
  const text = song.artist ?? '';
  const parts = text
    .split(/\s*(?:,|，|、|\/|&| feat\.?| ft\.?)\s*/i)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (parts.length > 0) return parts;
  names.push(UNKNOWN_ARTIST);
  return names;
};

/** 歌曲唯一 ID：mixSongId 优先，其次 fileId/id，兜底 '0'（三处调用方共用） */
export const resolveSongId = (song: HistoryStatsEntrySong) =>
  String(song.mixSongId || song.fileId || song.id || '0');

const startOfDay = (timestamp: number) => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 从播放历史条目聚合出统计快照。
 * 排序规则与 Next 一致：歌手/专辑按 plays→songs→名称（UTF-16 码点序），歌曲按 plays→最后播放时间。
 */
export const buildHistoryStats = (entries: HistoryStatsEntry[]): HistoryStats => {
  let totalPlays = 0;
  // 结算收听毫秒：本项目本地历史无此字段，恒为 0（时长指标卡显示占位）
  const listenedMs = 0;
  let replayed = 0;
  let latestAt = 0;
  let oldestAt = 0;

  interface ArtistAgg {
    name: string;
    plays: number;
    songs: number;
  }
  interface AlbumAgg {
    name: string;
    cover: string;
    coverPlays: number;
    plays: number;
    songs: number;
  }
  interface SongAgg {
    key: string;
    id: string;
    title: string;
    artist: string;
    cover: string;
    plays: number;
    at: number;
  }

  const artists = new Map<string, ArtistAgg>();
  const albums = new Map<string, AlbumAgg>();
  const songs: SongAgg[] = [];
  const playedAts: number[] = [];

  for (const entry of entries) {
    const song = entry.song;
    const plays = Math.max(1, Number(entry.playCount) || 0);
    const at = entry.lastPlayedAt > 0 ? entry.lastPlayedAt : 0;
    totalPlays += plays;
    if (plays > 1) replayed += 1;
    if (at > 0) {
      playedAts.push(at);
      if (latestAt === 0 || at > latestAt) latestAt = at;
      if (oldestAt === 0 || at < oldestAt) oldestAt = at;
    }
    for (const name of artistNames(song)) {
      const artist = artists.get(name) ?? { name, plays: 0, songs: 0 };
      artist.plays += plays;
      artist.songs += 1;
      artists.set(name, artist);
    }
    const albumName = (song.albumName || song.album || '').trim() || UNKNOWN_ALBUM;
    const album = albums.get(albumName) ?? {
      name: albumName,
      cover: '',
      coverPlays: -1,
      plays: 0,
      songs: 0,
    };
    album.plays += plays;
    album.songs += 1;
    const cover = song.coverUrl || song.cover || '';
    if (cover && plays > album.coverPlays) {
      album.cover = cover;
      album.coverPlays = plays;
    }
    albums.set(albumName, album);
    songs.push({
      key: entry.historyKey,
      id: resolveSongId(song),
      title: song.name || UNKNOWN_SONG,
      artist: song.artist || UNKNOWN_ARTIST,
      cover,
      plays,
      at,
    });
  }

  const totalSongs = entries.length;
  const replayPercent = totalSongs > 0 ? Math.round((replayed * 100.0) / totalSongs) : 0;

  const statCards: HistoryStatCard[] = [
    {
      label: '听过的歌曲',
      value: compact(totalSongs),
      unit: '首',
      caption: '每首歌，都是一次相遇',
    },
    {
      label: '已记录时长',
      // 占位口径：本地未结算收听时长（Next 为 listened_ms 结算值）
      value: listenDuration(listenedMs / 1000),
      unit: '',
      // 本地历史无结算数据，数字恒为占位；文案明示口径，不暗示有真实时长
      caption: '本地暂未结算收听时长',
    },
    {
      label: '常听歌手',
      value: compact(artists.size),
      unit: '位',
      caption: '不同的声音，同样的喜欢',
    },
    {
      label: '复听歌曲占比',
      value: String(replayPercent),
      unit: '%',
      caption: `${replayed} 首歌曲不止听过一次`,
    },
  ];

  const artistList = Array.from(artists.values()).sort(
    (a, b) =>
      b.plays - a.plays || b.songs - a.songs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const maxArtistPlays = artistList.length > 0 ? artistList[0].plays : 1;
  const topArtists: HistoryTopArtist[] = artistList.slice(0, 12).map((artist) => ({
    name: artist.name,
    songs: artist.songs,
    plays: artist.plays,
    ratio: artist.plays / maxArtistPlays,
  }));

  songs.sort((a, b) => b.plays - a.plays || b.at - a.at);
  const albumList = Array.from(albums.values()).sort(
    (a, b) =>
      b.plays - a.plays || b.songs - a.songs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const topAlbum: HistoryTopAlbum = albumList[0]
    ? {
        name: albumList[0].name,
        cover: albumList[0].cover,
        plays: albumList[0].plays,
        songs: albumList[0].songs,
      }
    : { name: '', cover: '', plays: 0, songs: 0 };

  const topSongs: HistoryTopSong[] = songs.slice(0, 6).map((song) => ({
    key: song.key,
    id: song.id,
    title: song.title,
    artist: song.artist,
    cover: song.cover,
    plays: song.plays,
    lastPlayedLabel: playDate(song.at),
  }));

  // 足迹视图：只呈现每首歌最后出现的日期/时刻（存储层语义），非事件时间线
  const dateCounts = new Map<number, number>();
  const hourCounts: number[] = new Array(24).fill(0);
  for (const at of playedAts) {
    const dayStart = startOfDay(at);
    dateCounts.set(dayStart, (dateCounts.get(dayStart) ?? 0) + 1);
    hourCounts[new Date(at).getHours()] += 1;
  }

  // 日历窗口：以本周日结尾、回溯 35 天（对齐 Next 的 Qt dayOfWeek 语义，周一=1 … 周日=7）
  const today = new Date();
  const todayStart = startOfDay(today.getTime());
  const todayQDay = today.getDay() === 0 ? 7 : today.getDay();
  const calendarEndStart = todayStart + (7 - todayQDay) * DAY_MS;
  const calendarStartStart = calendarEndStart - (CALENDAR_DAY_COUNT - 1) * DAY_MS;

  let calendarMax = 1;
  let calendarSongs = 0;
  for (let i = 0; i < CALENDAR_DAY_COUNT; i += 1) {
    const dayCount = dateCounts.get(calendarStartStart + i * DAY_MS) ?? 0;
    if (dayCount > calendarMax) calendarMax = dayCount;
  }
  const calendarDays: HistoryCalendarDay[] = [];
  for (let i = 0; i < CALENDAR_DAY_COUNT; i += 1) {
    const dayStart = calendarStartStart + i * DAY_MS;
    const date = new Date(dayStart);
    const count = dateCounts.get(dayStart) ?? 0;
    calendarSongs += count;
    calendarDays.push({
      day: date.getDate(),
      date: formatDateKey(date),
      count,
      ratio: count / calendarMax,
      today: dayStart === todayStart,
      future: dayStart > todayStart,
    });
  }

  let maxHour = 1;
  let peakHour = -1;
  for (let i = 0; i < 24; i += 1) {
    if (hourCounts[i] > (peakHour < 0 ? 0 : hourCounts[peakHour])) peakHour = i;
    if (hourCounts[i] > maxHour) maxHour = hourCounts[i];
  }
  const hourlyFootprint: HistoryHourFootprint[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourCounts[hour],
    ratio: hourCounts[hour] / maxHour,
  }));

  const calendarStartDate = new Date(calendarStartStart);
  return {
    totalSongs,
    totalPlays,
    totalPlaysLabel: compact(totalPlays),
    listenedMs,
    statCards,
    topArtists,
    topAlbum,
    topSongs,
    calendarDays,
    calendarSongs,
    calendarLabel: `${formatShortDate(calendarStartDate)} — ${formatShortDate(today)}`,
    hourlyFootprint,
    peakHourLabel: peakHour < 0 ? '—' : `${String(peakHour).padStart(2, '0')}:00`,
    replayPercent,
    datedSongs: playedAts.length,
    dateRangeLabel:
      oldestAt > 0 ? `${formatRangeDate(oldestAt)} — ${formatRangeDate(latestAt)}` : '',
    latestPlayedLabel: playDate(latestAt),
  };
};
