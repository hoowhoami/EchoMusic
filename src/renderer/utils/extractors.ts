import { isRecord, type UnknownRecord } from '../../shared/object';

const readList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const extractList = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const data = isRecord(payload.data) ? payload.data : undefined;
  const info = isRecord(payload.info) ? payload.info : undefined;
  const songs = isRecord(data?.songs) ? data?.songs : undefined;

  const candidates = [
    data?.special_list,
    data?.list,
    data?.info,
    data?.songlist,
    data?.song_list,
    data?.songs,
    songs?.list,
    songs?.songs,
    info?.list,
    info?.songs,
    info?.songlist,
    payload.special_list,
    payload.list,
    payload.info,
    payload.songlist,
    payload.song_list,
    payload.songs,
    payload.data,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
};

export const extractObject = (payload: unknown): UnknownRecord | undefined => {
  if (!isRecord(payload)) return undefined;
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.info)) return payload.info;
  return payload;
};

export const extractFirstObject = (payload: unknown): UnknownRecord | undefined => {
  const record = extractObject(payload);
  if (!record) return undefined;

  const listCandidates = [record.list, record.info, record.data, record.song_list, record.songs];
  for (const candidate of listCandidates) {
    if (Array.isArray(candidate) && candidate.length > 0 && isRecord(candidate[0])) {
      return candidate[0];
    }
  }

  return record;
};

export const extractAlbumGroups = (payload: unknown): Record<string, unknown> => {
  const record = extractObject(payload);
  if (!record) return {};

  const result: Record<string, unknown> = {};
  const keyMap: Record<string, string[]> = {
    chn: ['chn', '1'],
    eur: ['eur', '2'],
    jpn: ['jpn', '3'],
    kor: ['kor', '4'],
  };

  for (const [normalizedKey, aliases] of Object.entries(keyMap)) {
    for (const alias of aliases) {
      const value = record[alias];
      if (Array.isArray(value) && value.length > 0) {
        result[normalizedKey] = value;
        break;
      }
      if (isRecord(value)) {
        const list = readList(value.list ?? value.info ?? value.data);
        if (list.length > 0) {
          result[normalizedKey] = list;
          break;
        }
      }
    }
  }

  return result;
};
