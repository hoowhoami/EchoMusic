import request from '@/utils/request';
import { normalizeCommunityImpulseResponseUrl, normalizeCommunityVpfUrl } from '../../shared/audio';
import type { OnlineAudioEffectSource } from '../../shared/audio';

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
  source: OnlineAudioEffectSource;
  artistName?: string;
  brandName?: string;
  unavailableReason?: string;
}

export interface CommunityAudioEffectPage {
  items: CommunityAudioEffect[];
  total: number;
  page: number;
  pageSize: number;
}

export type CommunityAudioEffectSort = 2 | 3 | 4;

export interface AudioEffectBrand {
  id: number;
  name: string;
  logoUrl: string;
  modelCount: number;
}

export interface AudioEffectBrandPage {
  items: AudioEffectBrand[];
  total: number;
  page: number;
  pageSize: number;
}

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

const imageUrl = (value: unknown): string => {
  const raw = asString(value).replace(/\{size\}/g, '120');
  try {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

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

const normalizeCommunityAudioEffect = (
  value: unknown,
  source: OnlineAudioEffectSource = 'market',
): CommunityAudioEffect | null => {
  const record = asRecord(value);
  if (!record) return null;
  const id = Math.trunc(asNumber(record.id));
  const name = asString(record.name);
  if (id <= 0 || !name) return null;

  return {
    id,
    source,
    name,
    author: asString(record.author),
    intro: asString(record.intro),
    iconUrl: imageUrl(record.icon_url),
    tagName: asString(record.tag_name),
    labels: asStringArray(record.label),
    userCount: Math.max(0, Math.trunc(asNumber(record.user_count))),
    classify: Math.trunc(asNumber(record.classify)),
    // 优先 HTTPS 备用链；部分旧数据只有 HTTP 主链，统一升级为 HTTPS。
    soundUrls: uniqueResourceUrls(record.sound_bk, record.sound),
    vpfUrls: uniqueResourceUrls(record.vpf_bk, record.vpf),
    fileSize: Math.max(0, Math.trunc(asNumber(record.filesize))),
    artistName: asString(record.singername),
    unavailableReason:
      asNumber(record.privilege) > 0 || asNumber(record.singer_privilege) > 0
        ? '此音效需要上游授权，暂不支持下载'
        : undefined,
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
    throw new Error(asString(response?.error) || '音效市场加载失败');
  }

  return {
    items: (Array.isArray(response.data) ? response.data : [])
      .map((item) => normalizeCommunityAudioEffect(item))
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
    throw new Error(asString(response?.error) || '音效详情加载失败');
  }
  return asRecord(asRecord(response.data)?.info);
};

const pagination = (page: number, pageSize: number) => ({
  page: Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1,
  pageSize: Number.isFinite(pageSize) ? Math.min(50, Math.max(1, Math.trunc(pageSize))) : 20,
});

const effectResponse = (payload: unknown, message: string): UnknownRecord => {
  const response = asRecord(payload);
  if (!response || asNumber(response.status) !== 1) {
    throw new Error(asString(response?.error) || message);
  }
  return response;
};

const normalizeHeadphoneEffect = (value: unknown): CommunityAudioEffect | null => {
  const model = asRecord(value);
  if (!model) return null;
  // 型号 model_id 与 sound.id 属于不同命名空间；资源必须使用 sound.id。
  const effect = normalizeCommunityAudioEffect(model.sound, 'headphone');
  if (!effect) return null;
  return {
    ...effect,
    name: asString(model.model) || effect.name,
    iconUrl: imageUrl(model.model_icon) || effect.iconUrl,
    brandName: asString(model.brand_name),
    intro: effect.intro || '针对对应耳机型号调校，请选择与你的设备一致的型号。',
    unavailableReason:
      model.is_unlocked != null && asNumber(model.is_unlocked) !== 1
        ? '此耳机音效尚未解锁'
        : effect.unavailableReason,
  };
};

export const getArtistAudioEffects = async (
  page = 1,
  pageSize = 20,
): Promise<CommunityAudioEffectPage> => {
  const paging = pagination(page, pageSize);
  const response = effectResponse(
    await request.get('/effects/artist', {
      params: { page: paging.page, pagesize: paging.pageSize },
    }),
    '歌手音效加载失败',
  );
  return {
    ...paging,
    total: Math.max(0, Math.trunc(asNumber(response.total))),
    items: (Array.isArray(response.data) ? response.data : [])
      .map((item) => normalizeCommunityAudioEffect(item, 'artist'))
      .filter((item): item is CommunityAudioEffect => item !== null),
  };
};

export const getAudioEffectBrands = async (
  page = 1,
  pageSize = 30,
): Promise<AudioEffectBrandPage> => {
  const paging = pagination(page, pageSize);
  const response = effectResponse(
    await request.get('/effects/brand', {
      params: { page: paging.page, pagesize: paging.pageSize },
    }),
    '耳机品牌加载失败',
  );
  const data = asRecord(response.data);
  const items = (Array.isArray(data?.list) ? data.list : []).flatMap(
    (value): AudioEffectBrand[] => {
      const record = asRecord(value);
      const id = Math.trunc(asNumber(record?.brand_id));
      const name = asString(record?.brand);
      return id > 0 && name
        ? [
            {
              id,
              name,
              logoUrl: imageUrl(record?.logo),
              modelCount: Math.max(0, Math.trunc(asNumber(record?.model_count))),
            },
          ]
        : [];
    },
  );
  return { ...paging, items, total: Math.max(0, Math.trunc(asNumber(data?.total))) };
};

export const getHeadphoneAudioEffects = async (
  brandId: number,
  page = 1,
  pageSize = 20,
): Promise<CommunityAudioEffectPage> => {
  if (!Number.isSafeInteger(brandId) || brandId <= 0) throw new Error('请选择有效的耳机品牌');
  const paging = pagination(page, pageSize);
  const response = effectResponse(
    await request.get('/effects/brand/detail', {
      params: { brand_id: brandId, page: paging.page, pagesize: paging.pageSize },
    }),
    '耳机音效加载失败',
  );
  const data = asRecord(response.data);
  return {
    ...paging,
    total: Math.max(0, Math.trunc(asNumber(data?.total))),
    items: (Array.isArray(data?.list) ? data.list : [])
      .map(normalizeHeadphoneEffect)
      .filter((item): item is CommunityAudioEffect => item !== null),
  };
};

export const getCommonHeadphoneAudioEffect = async (): Promise<CommunityAudioEffect | null> => {
  const response = effectResponse(await request.get('/effects/match'), '通用耳机音效加载失败');
  return normalizeHeadphoneEffect(asRecord(response.data)?.common);
};
