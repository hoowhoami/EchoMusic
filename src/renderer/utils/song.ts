import type { Song, SongRelateGood } from '@/models/song';

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
  high: 'Hi-Res',
  flac: 'SQ',
  '320': 'HQ',
};

const EFFECT_QUALITIES = new Set([
  'piano',
  'acappella',
  'subwoofer',
  'ancient',
  'surnay',
  'dj',
  'viper_tape',
  'viper_atmos',
  'viper_clear',
]);

const AUDIO_QUALITY_ORDER: Array<'128' | '320' | 'flac' | 'high'> = ['128', '320', 'flac', 'high'];

export const isVipSong = (song: Song): boolean => song.privilege === 10 && song.payType === 3;

export const isPaidSong = (song: Song): boolean => song.privilege === 10 && song.payType === 2;

export const isNoCopyrightSong = (song: Song): boolean => song.privilege === 5;

export const isUnavailableSong = (song: Song): boolean => song.privilege === 40;

export const canPlaySong = (song: Song): boolean => {
  if (isUnavailableSong(song)) return false;
  if (isNoCopyrightSong(song)) return song.oldCpy === 1;
  return true;
};

export const isPlayableSong = (song: Song): boolean => Boolean(song.hash?.trim()) && canPlaySong(song);

export const isSameSong = (left: Song, right: Song): boolean => {
  const leftMixSongId = String(left.mixSongId ?? '0');
  const rightMixSongId = String(right.mixSongId ?? '0');
  if (leftMixSongId !== '0' && rightMixSongId !== '0' && leftMixSongId === rightMixSongId) {
    return true;
  }

  const leftHash = String(left.hash ?? '').trim().toLowerCase();
  const rightHash = String(right.hash ?? '').trim().toLowerCase();
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
  if (isPaidSong(song)) return '需要购买';
  if (isNoCopyrightSong(song)) return '无版权';
  if (isUnavailableSong(song)) return '不可用';
  return '暂无音源';
};

export const getSongQualityTag = (song: Pick<Song, 'relateGoods'>): string => {
  const goods = song.relateGoods ?? [];
  const hasQuality = (quality: string, level: number) =>
    goods.some((item: SongRelateGood) => item.quality === quality || item.level === level);

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
  quality: '128' | '320' | 'flac' | 'high',
): boolean => {
  if (quality === '128') return true;

  const normalizedQuality = String(item.quality ?? '').trim().toLowerCase();
  const level = item.level;

  if (quality === '320') {
    return normalizedQuality === '320' || normalizedQuality === 'hq' || level === 4;
  }

  if (quality === 'flac') {
    return normalizedQuality === 'flac' || normalizedQuality === 'sq' || level === 5;
  }

  return normalizedQuality === 'high' || normalizedQuality === 'hires' || normalizedQuality === 'hi-res' || normalizedQuality === 'res' || level === 6;
};

export const hasSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  quality: '128' | '320' | 'flac' | 'high',
): boolean => {
  if (quality === '128') return true;
  const goods = song.relateGoods ?? [];
  return goods.some((item: SongRelateGood) => doesRelateGoodMatchQuality(item, quality));
};

export const getAvailableSongQualities = (
  song: Pick<Song, 'relateGoods'>,
): Array<'128' | '320' | 'flac' | 'high'> => {
  const result: Array<'128' | '320' | 'flac' | 'high'> = ['128'];
  if (hasSongQuality(song, '320')) result.push('320');
  if (hasSongQuality(song, 'flac')) result.push('flac');
  if (hasSongQuality(song, 'high')) result.push('high');
  return result;
};


export const getSongQualityCandidates = (
  preferred: '128' | '320' | 'flac' | 'high',
  compatibilityMode = true,
): Array<'128' | '320' | 'flac' | 'high'> => {
  const normalized = AUDIO_QUALITY_ORDER.includes(preferred) ? preferred : '128';
  const index = AUDIO_QUALITY_ORDER.indexOf(normalized);
  if (!compatibilityMode) return [normalized];
  return AUDIO_QUALITY_ORDER.slice(0, index + 1).reverse() as Array<'128' | '320' | 'flac' | 'high'>;
};

export const resolveEffectiveSongQuality = (
  song: Pick<Song, 'relateGoods'>,
  preferred: '128' | '320' | 'flac' | 'high',
  compatibilityMode = true,
): '128' | '320' | 'flac' | 'high' => {
  const goods = song.relateGoods ?? [];
  if (goods.length === 0) return preferred;

  const candidates = getSongQualityCandidates(preferred, compatibilityMode);
  for (const quality of candidates) {
    if (hasSongQuality(song, quality)) return quality;
  }

  const available = getAvailableSongQualities(song);
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
  const title = String(song.title ?? '').trim();
  const artist = String(song.artist ?? '').trim();
  const album = String(song.album ?? '').trim();
  const cover = String(song.coverUrl ?? '').trim();
  const hash = String(song.hash ?? '').trim();
  const mixSongId = String(song.mixSongId ?? '0').trim();
  const artists = song.artists ?? [];

  return !hash && !title && !artist && artists.length === 0 && !album && !cover && (!mixSongId || mixSongId === '0');
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
