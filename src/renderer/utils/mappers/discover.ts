import type { Song } from '@/models/song';
import { mapTopSong } from './song';
import {
  buildArtists,
  buildRelateGoods,
  getArray,
  getRecord,
  isRecord,
  pickValue,
  readString,
} from './shared';

export interface DiscoverItem {
  key: string;
  song: Song;
  algPath: string;
  itemId: string;
}

export const mapDiscoverItems = (payload: unknown): DiscoverItem[] => {
  if (!isRecord(payload)) return [];
  const rows = getArray(getRecord(payload, 'data')?.items) ?? [];
  const result: DiscoverItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isRecord(row) || row.item_type !== 'song') continue;
    const info = getRecord(row, 'song_info');
    if (!info) continue;
    const song = mapTopSong({
      ...info,
      album_id: pickValue(info.album_id, info.ori_album_id),
      album_sizable_cover: pickValue(info.album_sizable_cover, info.album_cover),
      hash: pickValue(info.hash, info.hash_128, info.hash_320),
      timelength: pickValue(info.timelength, info.timelength_128, info.timelength_320),
    });
    // Keep the size placeholder for large artwork; coverUrl remains the list thumbnail.
    song.cover = readString(pickValue(info.album_sizable_cover, info.album_cover, song.cover));
    const key = String(song.mixSongId || song.id);
    if (!key || !song.id || seen.has(key)) continue;
    seen.add(key);
    result.push({ key, song, algPath: readString(row.alg_path), itemId: readString(row.item_id) });
  }
  return result;
};

export const applyDiscoverQualities = (items: DiscoverItem[], payload: unknown): DiscoverItem[] => {
  if (!isRecord(payload)) return items;
  const records = (getArray(payload.data) ?? []).filter(isRecord);
  return items.map((item) => {
    const record = records.find(
      (entry) => readString(entry.hash).toLowerCase() === item.song.hash.toLowerCase(),
    );
    if (!record) return item;
    const relateGoods = buildRelateGoods(record, {});
    if (!relateGoods.length) return item;
    return { ...item, song: { ...item.song, relateGoods } };
  });
};

export const applyDiscoverMetadata = (items: DiscoverItem[], payload: unknown): DiscoverItem[] => {
  if (!isRecord(payload)) return items;
  const records = (getArray(payload.data) ?? []).filter(isRecord);
  return items.map((item) => {
    // Responses may be reordered or omit unavailable songs. Never join by array position.
    const record = records.find(
      (entry) => readString(getRecord(entry, 'base')?.album_audio_id) === item.key,
    );
    if (!record) return item;
    const authors = (getArray(record.authors) ?? [])
      .filter(isRecord)
      .map((author) => getRecord(author, 'base'))
      .filter(isRecord);
    const artists = buildArtists({ authors }, {});
    const album = getRecord(record, 'album_info');
    const base = getRecord(record, 'base');
    const song: Song = { ...item.song };
    if (artists.length) {
      song.artists = artists;
      song.singers = artists;
      song.artist = artists.map((artist) => artist.name).join(', ');
    }
    if (album?.album_id) song.albumId = readString(album.album_id);
    if (album?.album_name) song.album = song.albumName = readString(album.album_name);
    if (base?.language) song.language = readString(base.language);
    return { ...item, song };
  });
};
