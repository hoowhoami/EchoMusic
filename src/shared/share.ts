export const SHARE_SCHEME = 'echomusic';
export const SHARE_WEB_BASE_URL = 'https://hoowhoami.github.io/EchoMusic/share/';

export type ShareResourceType = 'song' | 'playlist' | 'artist' | 'album';
export type ShareTargetQuery = Record<string, string>;

export interface ShareTarget {
  type: ShareResourceType;
  id: string;
  title?: string;
  sharer?: string;
  query?: ShareTargetQuery;
}

export interface ShareCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SHARE_TYPE_LABELS: Record<ShareResourceType, string> = {
  song: '歌曲',
  playlist: '歌单',
  artist: '歌手',
  album: '专辑',
};

const SHARE_WEB_ORIGIN = new URL(SHARE_WEB_BASE_URL).origin;
const SHARE_WEB_PATH = new URL(SHARE_WEB_BASE_URL).pathname.replace(/\/$/, '');

const isShareResourceType = (value: string): value is ShareResourceType =>
  value === 'song' || value === 'playlist' || value === 'artist' || value === 'album';

const readText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value).trim();
};

export const isSongShareId = (value: unknown): boolean => /^[a-f0-9]{32}$/i.test(readText(value));

const stripTrailingUrlPunctuation = (value: string) =>
  value.trim().replace(/[)\]}>,，。！？；;]+$/g, '');

export const getShareResourceLabel = (type: ShareResourceType) => SHARE_TYPE_LABELS[type];

const normalizeShareQuery = (query: Record<string, unknown> | undefined): ShareTargetQuery => {
  const result: ShareTargetQuery = {};
  if (!query) return result;
  Object.entries(query).forEach(([key, value]) => {
    const name = readText(key);
    const text = readText(value);
    if (name && text) result[name] = text;
  });
  return result;
};

const readSearchParams = (searchParams: URLSearchParams, excludedKeys: string[] = []) => {
  const excluded = new Set(excludedKeys);
  const query: ShareTargetQuery = {};
  searchParams.forEach((value, key) => {
    if (excluded.has(key)) return;
    const name = readText(key);
    const text = readText(value);
    if (name && text) query[name] = text;
  });
  return query;
};

const withQuery = (target: ShareTarget, query: ShareTargetQuery): ShareTarget =>
  Object.keys(query).length > 0 ? { ...target, query } : target;

const parseCustomShareUrl = (value: string): ShareTarget | null => {
  const text = stripTrailingUrlPunctuation(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== `${SHARE_SCHEME}:`) return null;

  const segments = url.pathname
    .split('/')
    .map((segment) => decodeURIComponent(segment.trim()))
    .filter(Boolean);
  const typeText = url.hostname || segments.shift() || '';
  if (!isShareResourceType(typeText)) return null;

  const id = readText(segments.shift());
  if (!id) return null;
  if (typeText === 'song' && !isSongShareId(id)) return null;

  return withQuery({ type: typeText, id }, readSearchParams(url.searchParams));
};

const parseShareTargetParts = (
  type: string | null,
  id: string | null,
  query: ShareTargetQuery = {},
): ShareTarget | null => {
  const typeText = readText(type);
  if (!isShareResourceType(typeText)) return null;

  const targetId = readText(id);
  if (!targetId) return null;
  if (typeText === 'song' && !isSongShareId(targetId)) return null;

  return withQuery({ type: typeText, id: targetId }, query);
};

export const buildShareUrl = (target: ShareTarget): string => {
  const id = readText(target.id);
  if (!isShareResourceType(target.type) || !id) {
    throw new Error('Invalid share target');
  }
  if (target.type === 'song' && !isSongShareId(id)) {
    throw new Error('Invalid song share target');
  }

  const url = new URL(`${SHARE_SCHEME}://${target.type}/${encodeURIComponent(id)}`);
  const query = normalizeShareQuery(target.query);
  Object.entries(query).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
};

export const buildShareWebUrl = (target: ShareTarget): string => {
  const id = readText(target.id);
  if (!isShareResourceType(target.type) || !id) {
    throw new Error('Invalid share target');
  }
  if (target.type === 'song' && !isSongShareId(id)) {
    throw new Error('Invalid song share target');
  }

  const url = new URL(SHARE_WEB_BASE_URL);
  if (Object.keys(normalizeShareQuery(target.query)).length === 0) {
    url.searchParams.set('type', target.type);
    url.searchParams.set('id', id);
  } else {
    url.searchParams.set('target', buildShareUrl({ ...target, id }));
  }
  return url.toString();
};

export const parseShareWebUrl = (value: string): ShareTarget | null => {
  const text = stripTrailingUrlPunctuation(value);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.origin !== SHARE_WEB_ORIGIN) return null;

  const pathname = url.pathname.replace(/\/$/, '');
  if (pathname !== SHARE_WEB_PATH && !pathname.startsWith(`${SHARE_WEB_PATH}/`)) return null;

  const targetParam = readText(url.searchParams.get('target'));
  if (targetParam) {
    const target = parseCustomShareUrl(targetParam);
    if (target) return target;
  }

  const queryTarget = parseShareTargetParts(
    url.searchParams.get('type'),
    url.searchParams.get('id'),
    readSearchParams(url.searchParams, ['type', 'id', 'target']),
  );
  if (queryTarget) return queryTarget;

  const pathRest = pathname.slice(SHARE_WEB_PATH.length).replace(/^\/+/, '');
  const [pathType, ...pathIdParts] = pathRest.split('/').filter(Boolean);
  if (!pathType || pathIdParts.length === 0) return null;

  return parseShareTargetParts(
    pathType,
    decodeURIComponent(pathIdParts.join('/')),
    readSearchParams(url.searchParams, ['target']),
  );
};

export const parseShareUrl = (value: string): ShareTarget | null =>
  parseCustomShareUrl(value) || parseShareWebUrl(value);

export const isShareUrl = (value: string): boolean => parseShareUrl(value) !== null;

export const extractShareTarget = (value: string): ShareTarget | null => {
  const text = readText(value);
  if (!text) return null;

  const directTarget = parseShareUrl(text);
  if (directTarget) return directTarget;

  const candidates = text.match(/echomusic:\/\/[^\s<>"'`]+|https?:\/\/[^\s<>"'`]+/gi) ?? [];
  for (const candidate of candidates) {
    const target = parseShareUrl(candidate);
    if (target) return target;
  }

  return null;
};

export const buildShareText = (target: ShareTarget): string => {
  const title = readText(target.title);
  const sharer = readText(target.sharer) || 'EchoMusic';
  const label = SHARE_TYPE_LABELS[target.type];
  const headline = `${sharer} 给你分享了${label}${title ? `「${title}」` : ''}，快去看看吧`;
  return `${headline}\n${buildShareWebUrl(target)}`;
};
