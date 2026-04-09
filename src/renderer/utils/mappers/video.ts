import type { VideoAuthor, VideoMeta, VideoSource, VideoTag } from '@/models/video';
import { getCoverUrl } from '@/utils/cover';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const readString = (value: unknown, fallback = ''): string => {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
};

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const parseDuration = (value: unknown): number => {
  const parsed = parseNumber(value);
  if (!parsed || parsed <= 0) return 0;
  return parsed > 1000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
};

const dedupeBy = <T>(list: T[], getKey: (item: T) => string) => {
  const used = new Set<string>();
  return list.filter((item) => {
    const key = getKey(item);
    if (!key || used.has(key)) return false;
    used.add(key);
    return true;
  });
};

const parseAuthors = (value: unknown): VideoAuthor[] => {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => toRecord(item))
      .map((item) => ({
        id: parseNumber(item.author_id ?? item.id ?? item.user_id),
        name: readString(item.author_name ?? item.name, ''),
        avatar: getCoverUrl(readString(item.sizable_avatar ?? item.avatar ?? '', ''), 240),
      }))
      .filter((item) => item.name),
    (item) => `${item.id ?? ''}-${item.name}`,
  );
};

const parseTags = (value: unknown): VideoTag[] => {
  if (!Array.isArray(value)) return [];
  return dedupeBy(
    value
      .map((item) => toRecord(item))
      .map((item) => ({
        id: parseNumber(item.tag_id ?? item.id),
        name: readString(item.tag_name ?? item.name, ''),
      }))
      .filter((item) => item.name),
    (item) => item.name,
  );
};

const QUALITY_ORDER = ['fhd', 'hd', 'qhd', 'sd', 'ld'] as const;

const QUALITY_META: Record<
  (typeof QUALITY_ORDER)[number],
  { label: string; height?: number; width?: number }
> = {
  fhd: { label: '1080P', height: 1080, width: 1920 },
  hd: { label: '720P', height: 720, width: 1280 },
  qhd: { label: '540P', height: 540, width: 960 },
  sd: { label: '432P', height: 432, width: 768 },
  ld: { label: '270P', height: 270, width: 480 },
};

const buildSourceListFromCodecMap = (
  codecRecord: UnknownRecord,
  codecLabel: string,
  thumb = '',
): VideoSource[] => {
  const sources: VideoSource[] = [];

  for (const quality of QUALITY_ORDER) {
    const hash = readString(codecRecord[`${quality}_hash`], '');
    if (!hash) continue;

    const meta = QUALITY_META[quality];
    const width = parseNumber(codecRecord[`${quality}_width`]) ?? meta.width;
    const height = parseNumber(codecRecord[`${quality}_height`]) ?? meta.height;
    const bitrate = parseNumber(codecRecord[`${quality}_bitrate`]);
    const size = parseNumber(codecRecord[`${quality}_filesize`]);

    sources.push({
      hash,
      url: '',
      label: meta.label,
      thumb,
      codec: codecLabel,
      bitrate,
      width,
      height,
      size,
    });
  }

  return sources;
};

const pickFirstSourceFromCodecMap = (
  codecRecord: UnknownRecord,
  codecLabel: string,
  thumb = '',
): VideoSource | null => {
  const sources = buildSourceListFromCodecMap(codecRecord, codecLabel, thumb);
  return sources[0] ?? null;
};

const collectSourcesFromMvRecord = (record: UnknownRecord): VideoSource[] => {
  const thumb = getCoverUrl(
    readString(record.hdpic ?? record.thumb ?? record.img ?? record.image, ''),
    360,
  );
  const codecMap: Array<{ key: string; label: string }> = [
    { key: 'h265', label: 'H.265' },
    { key: 'h264', label: 'H.264' },
    { key: 'mkv', label: 'MKV' },
  ];

  for (const codec of codecMap) {
    const codecRecord = toRecord(record[codec.key]);
    const source = pickFirstSourceFromCodecMap(codecRecord, codec.label, thumb);
    if (source) return [source];
  }

  return [];
};

const resolveMvRecords = (payload: unknown): UnknownRecord[] => {
  const root = toRecord(payload);
  const data = root.data;
  if (!Array.isArray(data) || data.length === 0) return [];

  const firstGroup = data[0];
  if (!Array.isArray(firstGroup) || firstGroup.length === 0) return [];

  return firstGroup.filter((item): item is UnknownRecord => isRecord(item));
};

const resolveMvRecord = (payload: unknown): UnknownRecord | null => {
  const records = resolveMvRecords(payload);
  if (records.length === 0) return null;

  return records[0] ?? null;
};

const resolveDetailRecord = (payload: unknown): UnknownRecord | null => {
  const root = toRecord(payload);
  const data = root.data;
  if (Array.isArray(data) && data.length > 0 && isRecord(data[0])) {
    return data[0];
  }
  return null;
};

const resolvePrivilegeRecord = (payload: unknown, targetHash = ''): UnknownRecord | null => {
  const root = toRecord(payload);
  const data = toRecord(root.data);
  const lowerHash = targetHash.trim().toLowerCase();

  if (lowerHash && isRecord(data[lowerHash])) {
    return {
      hash: lowerHash,
      ...toRecord(data[lowerHash]),
    };
  }

  const firstKey = Object.keys(data)[0];
  if (firstKey && isRecord(data[firstKey])) {
    return {
      hash: firstKey,
      ...toRecord(data[firstKey]),
    };
  }

  return null;
};

const parsePublishTime = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ts = Date.parse(value.replace(/-/g, '/'));
  if (!Number.isFinite(ts) || ts <= 0) return undefined;
  return Math.floor(ts / 1000);
};

export const mapVideoMeta = (payload: unknown, targetHash = ''): VideoMeta | null => {
  const mvRecord = resolveMvRecord(payload);
  const detailRecord = resolveDetailRecord(payload);
  const privilegeRecord = resolvePrivilegeRecord(payload, targetHash);
  const record = mvRecord ?? detailRecord ?? privilegeRecord;

  if (!record) return null;

  const hash = readString(record.hash ?? targetHash, targetHash);
  const cover = readString(record.hdpic ?? record.thumb ?? record.img ?? record.image, '');
  const playCount =
    parseNumber(record.play_times) ??
    parseNumber(record.hit) ??
    parseNumber(record.play_count) ??
    parseNumber(record.hot);

  return {
    id: readString(record.video_id ?? record.id ?? hash, hash),
    hash,
    title: readString(record.mv_name ?? record.name ?? record.video_name, 'MV播放'),
    description: readString(record.desc ?? record.remark ?? '', ''),
    remark: readString(record.remark ?? '', ''),
    topic: readString(record.topic ?? '', ''),
    coverUrl: getCoverUrl(cover, 720),
    duration: parseDuration(record.duration),
    playCount,
    publishTime: parsePublishTime(record.publish_time),
    albumAudioId: readString(record.album_audio_id ?? record.audio_id ?? '', ''),
    songName: readString(record.mv_name ?? record.name ?? '', ''),
    artistName: readString(record.singer ?? record.singer_name ?? '', ''),
    albumName: readString(record.other_desc ?? '', ''),
    authors: parseAuthors(record.authors),
    tags: parseTags(record.tags),
    sources: collectSourcesFromMvRecord(record),
    collectionCount: parseNumber(record.collection_total),
    downloadCount: parseNumber(record.download_total),
    hotScore: parseNumber(record.hot),
    recommend: Number(parseNumber(record.is_recommend) ?? 0) === 1,
    raw: record,
  };
};

export const mapVideoMetaList = (payload: unknown): VideoMeta[] => {
  const records = resolveMvRecords(payload);
  return records
    .map((record) => mapVideoMeta({ data: [[record]] }))
    .filter((item): item is VideoMeta => item !== null);
};

export const extractVideoUrl = (payload: unknown, targetHash = ''): string => {
  const root = toRecord(payload);
  const data = toRecord(root.data);
  const lowerHash = targetHash.trim().toLowerCase();
  const candidate = lowerHash && isRecord(data[lowerHash]) ? toRecord(data[lowerHash]) : null;
  const entry = candidate ?? (Object.keys(data)[0] ? toRecord(data[Object.keys(data)[0]]) : {});
  const backup = Array.isArray(entry.backupdownurl) ? entry.backupdownurl[0] : undefined;
  return readString(entry.downurl ?? entry.url ?? entry.play_url ?? backup, '');
};

export const mapVideoSourcesFromPrivilege = (payload: unknown): VideoSource[] => {
  const root = toRecord(payload);
  const list = Array.isArray(root.data) ? root.data : [];
  const mapped = list
    .slice(0, 1)
    .map((item) => toRecord(item))
    .map((item): VideoSource | null => {
      const info = toRecord(item.info);
      const hash = readString(item.hash, '');
      if (!hash) return null;
      return {
        hash,
        url: '',
        thumb: getCoverUrl(readString(item.hdpic ?? item.thumb ?? item.img ?? item.image, ''), 360),
        label:
          (parseNumber(item.level) === 5 && '1080P') ||
          (parseNumber(item.level) === 4 && '720P') ||
          (parseNumber(item.level) === 3 && '540P') ||
          (parseNumber(item.level) === 2 && '432P') ||
          (parseNumber(item.level) === 1 && '270P') ||
          `等级 ${readString(item.level, '--')}`,
        codec: 'MP4',
        bitrate: parseNumber(info.bitrate),
        size: parseNumber(info.filesize ?? item.filesize),
      } satisfies VideoSource;
    })
    .filter((item): item is VideoSource => item !== null);

  return mapped;
};

export const mergeVideoSources = (...groups: VideoSource[][]): VideoSource[] => {
  const merged = new Map<string, VideoSource>();

  for (const group of groups) {
    for (const item of group) {
      if (!item.hash) continue;
      const key = item.hash.toLowerCase();
      const previous = merged.get(key);
      merged.set(key, {
        ...(previous ?? {}),
        ...item,
        hash: item.hash,
        label: item.label || previous?.label || '默认',
        url: item.url || previous?.url || '',
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    const leftPixels = (left.height ?? 0) * (left.width ?? 0);
    const rightPixels = (right.height ?? 0) * (right.width ?? 0);
    if (leftPixels !== rightPixels) return rightPixels - leftPixels;
    return (right.bitrate ?? 0) - (left.bitrate ?? 0);
  });
};
