import type { Song, SongRelateGood } from '@/models/song';
import type { AudioQualityValue } from '@/types';

export interface SongPrivilegeTag {
  label: string;
  color: string;
  message: string;
}

export interface SongDerivedState {
  isVip: boolean;
  isPaid: boolean;
  isNoCopyright: boolean;
  isUnavailable: boolean;
  canPlay: boolean;
  isPlayable: boolean;
  unavailableMessage: string | null;
  qualityTag: string;
  privilegeTags: SongPrivilegeTag[];
}

const QUALITY_LABEL_MAP: Record<string, string> = {
  viper_tape: '母带',
  viper_clear: '超清',
  viper_atmos: '全景声',
  high: 'Hi-Res',
  flac: 'SQ',
  '320': 'HQ',
};

const EFFECT_QUALITIES = new Set([
  'piano',
  'vocal',
  'accompaniment',
  'subwoofer',
  'ancient',
  'surnay',
  'dj',
]);

const AUDIO_QUALITY_ORDER: AudioQualityValue[] = [
  '128',
  '320',
  'flac',
  'high',
  'viper_clear',
  'viper_tape',
  'viper_atmos',
];

export const isVipSong = (song: Song): boolean => song.privilege === 10 && song.payType === 3;

export const isPaidSong = (song: Song): boolean => song.privilege === 10 && song.payType === 2;

export const isNoCopyrightSong = (song: Song): boolean => song.privilege === 5;

export const isUnavailableSong = (song: Song): boolean => song.privilege === 40;

export const canPlaySong = (song: Song): boolean => {
  if (isUnavailableSong(song)) return false;
  if (isNoCopyrightSong(song)) return song.oldCpy === 1;
  return true;
};

export const isPlayableSong = (song: Song): boolean =>
  Boolean(song.hash?.trim() || song.audioUrl?.trim()) && canPlaySong(song);

export const isSameSong = (left: Song, right: Song): boolean => {
  const leftMixSongId = String(left.mixSongId ?? '0');
  const rightMixSongId = String(right.mixSongId ?? '0');
  if (leftMixSongId !== '0' && rightMixSongId !== '0' && leftMixSongId === rightMixSongId) {
    return true;
  }

  const leftHash = String(left.hash ?? '')
    .trim()
    .toLowerCase();
  const rightHash = String(right.hash ?? '')
    .trim()
    .toLowerCase();
  if (leftHash && rightHash && leftHash === rightHash) {
    return true;
  }

  return false;
};

export const getSongPrivilegeTags = (song: Song): SongPrivilegeTag[] => {
  const tags: SongPrivilegeTag[] = [];

  if (isPaidSong(song)) {
    tags.push({ label: '付费', color: '#EF4444', message: '需要购买' });
  }
  if (isVipSong(song)) {
    tags.push({ label: 'VIP', color: '#F59E0B', message: '需要VIP' });
  }
  if (!isPlayableSong(song) && isNoCopyrightSong(song)) {
    tags.push({ label: '版权', color: '#8B5CF6', message: '无版权' });
  }
  if (isUnavailableSong(song)) {
    tags.push({ label: '音源', color: '#6B7280', message: '不可用' });
  }

  return tags;
};

export const getSongUnavailableMessage = (song: Song): string | null => {
  if (isPlayableSong(song)) return null;
  if (isVipSong(song)) return '需要 VIP 权限';
  if (isPaidSong(song)) return '需要购买';
  if (isNoCopyrightSong(song)) return '无版权';
  if (isUnavailableSong(song)) return '不可用';
  return '暂不可播放';
};

export const getSongQualityTag = (song: Pick<Song, 'relateGoods' | 'qualityMap'>): string => {
  const goods = song.relateGoods ?? [];
  // 新版云歌单用位图返回音质能力，没有各音质的 hash；保留给标签展示使用。
  // 320/flac/high 分别为 bit 4/5/6；母带能力不展示为歌曲徽标。
  const qualityMap = goods.length ? 0 : (song.qualityMap ?? 0);
  const hasQuality = (quality: string, level: number) =>
    goods.some((item: SongRelateGood) => item.quality === quality || item.level === level) ||
    Boolean(qualityMap & (1 << level));

  if (goods.some((item) => item.quality === 'viper_atmos')) return '全景声';
  if (goods.some((item) => item.quality === 'viper_clear')) return '超清';
  if (hasQuality('high', 6)) return 'Hi-Res';
  if (hasQuality('flac', 5)) return 'SQ';
  if (hasQuality('320', 4)) return 'HQ';
  return '';
};

export const getSongQualityTags = (relateGoods: SongRelateGood[] | undefined): string[] => {
  if (!relateGoods?.length) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of relateGoods) {
    const quality = item.quality ?? '';
    const normalized = QUALITY_LABEL_MAP[quality] ?? '';
    if (!normalized || EFFECT_QUALITIES.has(quality) || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
};

export const getSongEffectTags = (relateGoods: SongRelateGood[] | undefined): string[] => {
  if (!relateGoods?.length) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of relateGoods) {
    const quality = item.quality ?? '';
    if (!quality || !EFFECT_QUALITIES.has(quality) || seen.has(quality)) continue;
    seen.add(quality);
    tags.push(quality);
  }
  return tags;
};

export const doesRelateGoodMatchQuality = (
  item: SongRelateGood,
  quality: AudioQualityValue,
): boolean => {
  const normalizedQuality = String(item.quality ?? '')
    .trim()
    .toLowerCase();
  const level = item.level;

  if (quality === '128') return normalizedQuality === '128' || level === 1 || level === 2;
  if (quality === 'viper_clear' || quality === 'viper_atmos') return normalizedQuality === quality;

  if (quality === '320') {
    return normalizedQuality === '320' || normalizedQuality === 'hq' || level === 4;
  }

  if (quality === 'flac') {
    return normalizedQuality === 'flac' || normalizedQuality === 'sq' || level === 5;
  }

  if (quality === 'high') {
    return (
      normalizedQuality === 'high' ||
      normalizedQuality === 'hires' ||
      normalizedQuality === 'hi-res' ||
      normalizedQuality === 'res' ||
      level === 6
    );
  }

  return normalizedQuality === 'viper_tape' || level === 101;
};

export const hasSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  quality: AudioQualityValue,
): boolean => {
  if (quality === '128') return true;
  const goods = song.relateGoods ?? [];
  return goods.some((item: SongRelateGood) => doesRelateGoodMatchQuality(item, quality));
};

export const isViperAudioQuality = (
  quality: string,
): quality is 'viper_tape' | 'viper_clear' | 'viper_atmos' =>
  quality === 'viper_tape' || quality === 'viper_clear' || quality === 'viper_atmos';

export const getAvailableSongQualities = (
  song: Pick<Song, 'relateGoods'>,
  viperQualityEnabled = true,
): AudioQualityValue[] => {
  return AUDIO_QUALITY_ORDER.filter(
    (quality) =>
      (viperQualityEnabled || !isViperAudioQuality(quality)) && hasSongQuality(song, quality),
  );
};

export const clampPreferredAudioQuality = (
  preferred: AudioQualityValue,
  viperQualityEnabled = true,
): AudioQualityValue => {
  if (!viperQualityEnabled && isViperAudioQuality(preferred)) return 'high';
  return AUDIO_QUALITY_ORDER.includes(preferred) ? preferred : '128';
};

export const getSongQualityCandidates = (
  preferred: AudioQualityValue,
  compatibilityMode = true,
  viperQualityEnabled = true,
): AudioQualityValue[] => {
  const normalized = clampPreferredAudioQuality(preferred, viperQualityEnabled);
  const index = AUDIO_QUALITY_ORDER.indexOf(normalized);
  if (!compatibilityMode) return [normalized];
  return AUDIO_QUALITY_ORDER.slice(0, index + 1).reverse();
};

export const resolveEffectiveSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  preferred: AudioQualityValue,
  compatibilityMode = true,
  viperQualityEnabled = true,
): AudioQualityValue => {
  const goods = song.relateGoods ?? [];
  const clampedPreferred = clampPreferredAudioQuality(preferred, viperQualityEnabled);
  if (goods.length === 0) return clampedPreferred;

  const candidates = getSongQualityCandidates(
    clampedPreferred,
    compatibilityMode,
    viperQualityEnabled,
  );
  for (const quality of candidates) {
    if (hasSongQuality(song, quality)) return quality;
  }

  const available = getAvailableSongQualities(song, viperQualityEnabled);
  return available[available.length - 1] ?? '128';
};

export const getSongDerivedState = (song: Song): SongDerivedState => {
  const isVip = isVipSong(song);
  const isPaid = isPaidSong(song);
  const isNoCopyright = isNoCopyrightSong(song);
  const isUnavailable = isUnavailableSong(song);
  const canPlay = canPlaySong(song);
  const isPlayable = isPlayableSong(song);
  const unavailableMessage = getSongUnavailableMessage(song);
  const qualityTag = getSongQualityTag(song);
  const privilegeTags = getSongPrivilegeTags(song);

  return {
    isVip,
    isPaid,
    isNoCopyright,
    isUnavailable,
    canPlay,
    isPlayable,
    unavailableMessage,
    qualityTag,
    privilegeTags,
  };
};

export const hasUsableSongHash = (song: Song): boolean => Boolean(String(song.hash ?? '').trim());

export const isMeaninglessHashlessSong = (song: Song): boolean => {
  const title = String(song.name ?? '').trim();
  const artist = String(song.artist ?? '').trim();
  const album = String(song.album ?? '').trim();
  const cover = String(song.coverUrl ?? '').trim();
  const hash = String(song.hash ?? '').trim();
  const mixSongId = String(song.mixSongId ?? '0').trim();
  const artists = song.artists ?? [];

  return (
    !hash &&
    !title &&
    !artist &&
    artists.length === 0 &&
    !album &&
    !cover &&
    (!mixSongId || mixSongId === '0')
  );
};

export const shouldFilterInvalidSong = (song: Song): boolean => {
  return isMeaninglessHashlessSong(song) || !hasUsableSongHash(song);
};

export const splitValidSongs = (songs: Song[]): { songs: Song[]; filteredCount: number } => {
  const validSongs: Song[] = [];
  let filteredCount = 0;

  for (const song of songs) {
    if (shouldFilterInvalidSong(song)) {
      filteredCount += 1;
      continue;
    }
    validSongs.push(song);
  }

  return {
    songs: validSongs,
    filteredCount,
  };
};

/**
 * 歌曲显示名。
 *
 * `name` 是 mapper 经 `processSongTitle` 剥离歌手前缀后的显示名，`title` 是接口
 * 原始名（云盘/歌单里常为「歌手 - 歌名.mp3」）。凡是面向用户的标题都必须优先取
 * `name`；`name` 缺失回落到 `title` 时还要再剥一次歌手前缀，否则标题会带上
 * 与 `artist` 字段重复的歌手信息。
 */
const songArtistNames = (song: Pick<Song, 'artist' | 'artists' | 'singers'>): string[] => {
  const names = [String(song.artist ?? '').trim()];
  for (const artist of song.artists ?? song.singers ?? []) {
    names.push(String(artist?.name ?? '').trim());
  }
  return names.filter(Boolean);
};

const stripArtistPrefix = (title: string, names: string[]): string => {
  for (const name of names) {
    const prefix = `${name} - `;
    if (prefix.length > 3 && title.startsWith(prefix)) return title.slice(prefix.length).trim();
  }
  return title;
};

export const getSongDisplayTitle = (
  song: Pick<Song, 'name' | 'title' | 'artist' | 'artists' | 'singers'>,
): string => {
  const name = String(song.name ?? '').trim();
  if (name) return name;
  return stripArtistPrefix(String(song.title ?? '').trim(), songArtistNames(song));
};

/**
 * 「歌名 - 歌手」形式的歌曲信息文本，供复制到剪贴板使用。
 *
 * 原始名可能已带「歌手 - 」前缀（接口把 `songname` 直接填成 `歌手 - 歌名`），
 * 直接与 `artist` 拼接会得到「歌手 - 歌名 - 歌手」，所以标题一律走
 * {@link getSongDisplayTitle} 剥离。
 */
export const formatSongInfoText = (song: Song): string => {
  const artist = String(song.artist ?? '').trim();
  const title = getSongDisplayTitle(song);
  if (!title) return artist;
  return artist ? `${title} - ${artist}` : title;
};
