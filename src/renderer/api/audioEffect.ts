import request from '@/utils/request';
import { normalizeCommunityImpulseResponseUrl, normalizeCommunityVpfUrl } from '../../shared/audio';

export interface CommunityAudioEffect {
  id: number;
  name: string;
  author: string;
  intro: string;
  iconUrl: string;
  tagName: string;
  labels: string[];
  userCount: number;
  classify: number;
  soundUrls: string[];
  vpfUrls: string[];
  fileSize: number;
}

export interface CommunityAudioEffectPage {
  items: CommunityAudioEffect[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommunityAudioEffectSort = 2 | 3 | 4;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;

const asString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const asNumber = (value: unknown): number => {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(asString).filter(Boolean) : [];

const uniqueResourceUrls = (...values: unknown[]): string[] => {
  const urls = new Set<string>();
  for (const value of values.flatMap((item) => (Array.isArray(item) ? item : [item]))) {
    const raw = asString(value);
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:') url.protocol = 'https:';
      if (url.protocol === 'https:') urls.add(url.toString());
    } catch {
      // 忽略上游列表中的无效资源地址。
    }
  }
  return [...urls];
};

const normalizeCommunityAudioEffect = (value: unknown): CommunityAudioEffect | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = Math.trunc(asNumber(record.id));
  const name = asString(record.name);
  if (id <= 0 || !name) return null;

  return {
    id,
    name,
    author: asString(record.author),
    intro: asString(record.intro),
    iconUrl: asString(record.icon_url),
    tagName: asString(record.tag_name),
    labels: asStringArray(record.label),
    userCount: Math.max(0, Math.trunc(asNumber(record.user_count))),
    classify: Math.trunc(asNumber(record.classify)),
    // 优先 HTTPS 备用链；部分旧数据只有 HTTP 主链，统一升级为 HTTPS。
    soundUrls: uniqueResourceUrls(record.sound_bk, record.sound),
    vpfUrls: uniqueResourceUrls(record.vpf_bk, record.vpf),
    fileSize: Math.max(0, Math.trunc(asNumber(record.filesize))),
  };
};

export const getCommunityImpulseResponseUrls = (effect: CommunityAudioEffect): string[] => {
  const urls = new Set<string>();
  for (const value of effect.soundUrls) {
    const normalized = normalizeCommunityImpulseResponseUrl(value);
    if (normalized) urls.add(normalized.toString());
  }
  return [...urls];
};

export const getCommunityImpulseResponseUrl = (effect: CommunityAudioEffect): string | null =>
  getCommunityImpulseResponseUrls(effect)[0] ?? null;

export const getCommunityVpfUrls = (effect: CommunityAudioEffect): string[] => {
  const urls = new Set<string>();
  for (const value of effect.vpfUrls) {
    const normalized = normalizeCommunityVpfUrl(value);
    if (normalized) urls.add(normalized.toString());
  }
  return [...urls];
};

export const getCommunityAudioEffects = async (
  page = 1,
  pageSize = 30,
  sort: CommunityAudioEffectSort = 2,
): Promise<CommunityAudioEffectPage> => {
  const normalizedPage = Math.max(1, Math.trunc(page) || 1);
  const normalizedPageSize = Math.min(50, Math.max(1, Math.trunc(pageSize) || 30));
  const normalizedSort: CommunityAudioEffectSort = sort === 3 || sort === 4 ? sort : 2;
  const payload = await request.get('/get/model', {
    params: { page: normalizedPage, pagesize: normalizedPageSize, sort: normalizedSort },
  });
  const response = asRecord(payload);
  if (!response || asNumber(response.status) !== 1) {
    throw new Error(asString(response?.error) || '社区音效加载失败');
  }

  return {
    items: (Array.isArray(response.data) ? response.data : [])
      .map(normalizeCommunityAudioEffect)
      .filter((item): item is CommunityAudioEffect => item !== null),
    total: Math.max(0, Math.trunc(asNumber(response.total))),
    page: normalizedPage,
    pageSize: normalizedPageSize,
  };
};

// 详情接口当前对部分新音效返回 null，调用方保留空结果语义。
export const getCommunityAudioEffectDetail = async (
  modelId: string | number,
): Promise<UnknownRecord | null> => {
  const payload = await request.get('/get/mode/info', {
    params: { model_id: modelId },
  });
  const response = asRecord(payload);
  if (!response || asNumber(response.status) !== 1) {
    throw new Error(asString(response?.error) || '社区音效详情加载失败');
  }
  return asRecord(asRecord(response.data)?.info);
};
