import request from '@/utils/request';

export type BlacklistLabel = 'song' | 'singer';

export interface BlacklistSongTarget {
  hash: string;
  mixSongId?: string | number;
  name?: string;
  moduleId?: number;
}

export interface BlacklistSingerTarget {
  singerId: string | number;
  name: string;
  moduleId?: number;
}

export interface BlacklistSongRemoveTarget {
  hash: string;
  mixSongId?: string | number;
  name?: string;
  moduleId?: number;
}

export interface BlacklistSingerRemoveTarget {
  singerId: string | number;
  name?: string;
  moduleId?: number;
}

export interface BlacklistSongEntry {
  label: 'song';
  key: string;
  name: string;
  mixSongId: string;
  createdAt: string;
}

export interface BlacklistSingerEntry {
  label: 'singer';
  key: string;
  name: string;
  createdAt: string;
}

export type BlacklistEntry = BlacklistSongEntry | BlacklistSingerEntry;

export interface BlacklistPage {
  label: BlacklistLabel;
  page: number;
  pageSize: number;
  total: number;
  entries: BlacklistEntry[];
}

export interface GetBlacklistPageOptions {
  label: BlacklistLabel;
  page?: number;
  pageSize?: number;
  moduleId?: number;
}

interface BlacklistApiResponse {
  status?: unknown;
  error_code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface BlacklistValue {
  n?: unknown;
  m?: unknown;
  t?: unknown;
}

const SOURCE_MAP: Record<BlacklistLabel, number> = {
  song: 3,
  singer: 4,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const requireText = (value: unknown, field: string): string => {
  const text = readText(value);
  if (!text) throw new TypeError(`${field} 不能为空`);
  return text;
};

const requirePositiveId = (value: unknown, field: string): string => {
  const text = requireText(value, field);
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) {
    throw new TypeError(`${field} 必须是正整数 ID`);
  }
  return text;
};

const requirePositiveInteger = (value: unknown, field: string, max?: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || (max !== undefined && number > max)) {
    const range = max === undefined ? '正整数' : `1 到 ${max} 之间的整数`;
    throw new TypeError(`${field} 必须是${range}`);
  }
  return number;
};

const normalizeModuleId = (value: number | undefined): number =>
  value === undefined ? 473 : requirePositiveInteger(value, 'moduleId');

const normalizeSongTarget = (target: BlacklistSongTarget) => ({
  hash: requireText(target.hash, 'hash').toLowerCase(),
  mixSongId: readText(target.mixSongId),
  name: readText(target.name),
  moduleId: normalizeModuleId(target.moduleId),
});

const normalizeSingerTarget = (target: BlacklistSingerTarget) => ({
  singerId: requirePositiveId(target.singerId, 'singerId'),
  name: requireText(target.name, 'name'),
  moduleId: normalizeModuleId(target.moduleId),
});

const normalizeSongRemoveTarget = (target: BlacklistSongRemoveTarget) => ({
  hash: requireText(target.hash, 'hash').toLowerCase(),
  mixSongId: readText(target.mixSongId),
  name: readText(target.name),
  moduleId: normalizeModuleId(target.moduleId),
});

const normalizeSingerRemoveTarget = (target: BlacklistSingerRemoveTarget) => ({
  singerId: requirePositiveId(target.singerId, 'singerId'),
  name: readText(target.name),
  moduleId: normalizeModuleId(target.moduleId),
});

const asResponse = (value: unknown): BlacklistApiResponse => {
  if (!isRecord(value)) throw new Error('偏好设置接口返回了无效响应');
  return value;
};

const assertBusinessSuccess = (value: unknown): BlacklistApiResponse => {
  const response = asResponse(value);
  const status = Number(response.status);
  const errorCode = Number(response.error_code ?? 0);
  if (status !== 1 || !Number.isFinite(errorCode) || errorCode !== 0) {
    const message = readText(response.msg) || `偏好设置操作失败（error_code=${errorCode}）`;
    throw new Error(message);
  }
  return response;
};

const parseValue = (value: unknown): BlacklistValue => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const normalizeEntry = (label: BlacklistLabel, value: unknown): BlacklistEntry | null => {
  if (!isRecord(value)) return null;
  const keyField = label === 'song' ? 'song_k' : 'singer_k';
  const valueField = label === 'song' ? 'song_v' : 'singer_v';
  const key = readText(value[keyField]);
  if (!key) return null;
  const parsed = parseValue(value[valueField]);
  const common = {
    key: label === 'song' ? key.toLowerCase() : key,
    name: readText(parsed.n),
    createdAt: readText(parsed.t) || readText(value.t),
  };
  if (label === 'song') {
    return {
      label,
      ...common,
      mixSongId: readText(parsed.m),
    };
  }
  return { label, ...common };
};

function createEntry(
  label: 'song',
  target: ReturnType<typeof normalizeSongTarget>,
): BlacklistSongEntry;
function createEntry(
  label: 'singer',
  target: ReturnType<typeof normalizeSingerTarget>,
): BlacklistSingerEntry;
function createEntry(
  label: BlacklistLabel,
  target: ReturnType<typeof normalizeSongTarget> | ReturnType<typeof normalizeSingerTarget>,
): BlacklistEntry {
  const createdAt = String(Math.floor(Date.now() / 1000));
  if (label === 'song' && 'hash' in target) {
    return {
      label,
      key: target.hash,
      name: target.name,
      mixSongId: target.mixSongId,
      createdAt,
    };
  }
  const singer = target as ReturnType<typeof normalizeSingerTarget>;
  return { label: 'singer', key: singer.singerId, name: singer.name, createdAt };
}

export const getBlacklistErrorMessage = (error: unknown, fallback = '偏好设置操作失败'): string => {
  if (error instanceof Error && error.message && !error.message.startsWith('API Error:')) {
    return error.message;
  }
  if (isRecord(error) && isRecord(error.response) && isRecord(error.response.body)) {
    const message = readText(error.response.body.msg);
    if (message) return message;
  }
  return fallback;
};

export async function getBlacklistPage(options: GetBlacklistPageOptions): Promise<BlacklistPage> {
  const label = options.label;
  if (label !== 'song' && label !== 'singer') throw new TypeError('label 必须是 song 或 singer');
  const page = requirePositiveInteger(options.page ?? 1, 'page');
  const pageSize = requirePositiveInteger(options.pageSize ?? 30, 'pageSize', 500);
  const response = assertBusinessSuccess(
    await request.get('/blacklist/list', {
      params: {
        label,
        source: SOURCE_MAP[label],
        page,
        pagesize: pageSize,
        moduleId: normalizeModuleId(options.moduleId),
      },
    }),
  );
  if (!isRecord(response.data)) throw new Error('偏好设置列表返回了无效数据');
  const rawItems = Array.isArray(response.data.items) ? response.data.items : [];
  const entries = rawItems
    .map((item) => normalizeEntry(label, item))
    .filter((item): item is BlacklistEntry => item !== null);
  const totalValue = Number(response.data.total);
  const responsePage = Number(response.data.page);
  const responsePageSize = Number(response.data.pagesize);

  return {
    label,
    page: Number.isSafeInteger(responsePage) && responsePage > 0 ? responsePage : page,
    pageSize:
      Number.isSafeInteger(responsePageSize) && responsePageSize > 0
        ? Math.min(responsePageSize, 500)
        : pageSize,
    total: Number.isSafeInteger(totalValue) && totalValue >= 0 ? totalValue : entries.length,
    entries,
  };
}

export async function addSongToBlacklist(target: BlacklistSongTarget): Promise<BlacklistSongEntry> {
  const normalized = normalizeSongTarget(target);
  assertBusinessSuccess(
    await request.get('/blacklist', {
      params: {
        label: 'song',
        source: SOURCE_MAP.song,
        hash: normalized.hash,
        ...(normalized.mixSongId ? { mixsongid: normalized.mixSongId } : {}),
        ...(normalized.name ? { name: normalized.name } : {}),
        moduleId: normalized.moduleId,
      },
    }),
  );
  return createEntry('song', normalized);
}

export async function addSingerToBlacklist(
  target: BlacklistSingerTarget,
): Promise<BlacklistSingerEntry> {
  const normalized = normalizeSingerTarget(target);
  assertBusinessSuccess(
    await request.get('/blacklist', {
      params: {
        label: 'singer',
        source: SOURCE_MAP.singer,
        singerid: normalized.singerId,
        name: normalized.name,
        moduleId: normalized.moduleId,
      },
    }),
  );
  return createEntry('singer', normalized);
}

export async function removeSongFromBlacklist(target: BlacklistSongRemoveTarget): Promise<string> {
  const normalized = normalizeSongRemoveTarget(target);
  assertBusinessSuccess(
    await request.get('/blacklist', {
      params: {
        label: 'song',
        source: SOURCE_MAP.song,
        hash: normalized.hash,
        mixsongid: normalized.mixSongId,
        name: normalized.name,
        moduleId: normalized.moduleId,
        isDelete: 1,
      },
    }),
  );
  return normalized.hash;
}

export async function removeSingerFromBlacklist(
  target: BlacklistSingerRemoveTarget,
): Promise<string> {
  const normalized = normalizeSingerRemoveTarget(target);
  assertBusinessSuccess(
    await request.get('/blacklist', {
      params: {
        label: 'singer',
        source: SOURCE_MAP.singer,
        singerid: normalized.singerId,
        name: normalized.name,
        moduleId: normalized.moduleId,
        isDelete: 1,
      },
    }),
  );
  return normalized.singerId;
}

export function removeBlacklistEntry(entry: BlacklistEntry): Promise<string> {
  if (entry.label === 'song') {
    return removeSongFromBlacklist({
      hash: entry.key,
      mixSongId: entry.mixSongId,
      name: entry.name,
    });
  }
  return removeSingerFromBlacklist({ singerId: entry.key, name: entry.name });
}
