import type { AudioQualityValue } from '@/types';
import { getAccountVipStatus } from './accountVip';

export interface SongQualityAccess {
  quality: AudioQualityValue;
  exists: boolean;
  obtainable: boolean;
  freeListen: boolean;
  needVip: boolean;
  requireVipType: string;
  sizeText: string;
  message: string;
}

export interface QualityMembership {
  concept: boolean;
  superVip: boolean;
}

export const getQualityAccessReason = (
  item: SongQualityAccess | undefined,
  membership: QualityMembership | null,
): string => {
  if (!item) return '音质权限信息缺失';
  if (!item.exists) return '歌曲不支持';
  if (item.obtainable || item.freeListen) return '';
  if (item.requireVipType === 'concept' || item.requireVipType === 'suvip') {
    if (!membership) return '会员权益尚未确认';
    if (item.requireVipType === 'concept') return membership.concept ? '' : '需概念版 VIP';
    return membership.superVip ? '' : '需超级 VIP';
  }
  return item.message || (item.needVip ? '需付费授权' : '当前不可用');
};

/** 权限响应缺失时保留普通音质兜底，蝰蛇档位仍需已确认的超级 VIP。 */
export const getPlaybackQualityAccessReason = (
  quality: AudioQualityValue,
  access: SongQualityAccess[] | null,
  membership: QualityMembership | null,
): string => {
  if (access)
    return getQualityAccessReason(
      access.find((item) => item.quality === quality),
      membership,
    );
  if (quality === 'viper_tape' || quality === 'viper_clear' || quality === 'viper_atmos') {
    return membership?.superVip ? '' : membership ? '需超级 VIP' : '会员权益尚未确认';
  }
  return '';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const flag = (value: unknown) => value === true || value === 1 || value === '1';
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const qualities = new Set([
  '128',
  '320',
  'flac',
  'high',
  'viper_clear',
  'viper_tape',
  'viper_atmos',
]);

/** quality_vip 是顶层扩展字段；按版权 hash 匹配，不以第一首代替当前歌曲。 */
export const parseSongQualityAccess = (
  payload: unknown,
  hash: string,
): SongQualityAccess[] | null => {
  const source = record(payload);
  if (Number(source.status) !== 1 || !Array.isArray(source.quality_vip)) return null;
  const song = source.quality_vip.find(
    (value) => text(record(value).hash).toLowerCase() === hash.trim().toLowerCase(),
  );
  const list = record(song).qualities;
  if (!Array.isArray(list) || !list.length) return null;
  return list.flatMap((value) => {
    const item = record(value);
    const quality = text(item.quality);
    if (!qualities.has(quality)) return [];
    return [
      {
        quality: quality as AudioQualityValue,
        exists: flag(item.exists),
        obtainable: flag(item.obtainable),
        freeListen: flag(item.free_listen),
        needVip: flag(item.need_vip),
        requireVipType: text(item.require_vip_type),
        sizeText: text(item.size_text),
        message: text(item.msg),
      },
    ];
  });
};

/** /youth/union/vip：vip_type=6 是豪华VIP，超级VIP检查 user_type & 16。 */
export const parseQualityMembership = (payload: unknown): QualityMembership | null => {
  const source = record(payload);
  if (Number(source.status) !== 1) return null;
  const data = record(source.data);
  if (!('vip_type' in data) && !('user_type' in data) && !Array.isArray(data.busi_vip)) return null;
  const status = getAccountVipStatus(data);
  const superVip = status.superVip;
  const concept = superVip || status.deluxeVip || !!status.conceptVip;
  return { concept, superVip };
};
