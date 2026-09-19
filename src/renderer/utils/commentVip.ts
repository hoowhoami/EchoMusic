/**
 * KugouYoung 5.1.9 comment username plate.
 *
 * Ported from `com.kugou.android.app.common.comment.utils.o` (`q` / `p` / `w` / `J`)
 * and `BusiVip` in KugouYoung_201_V5.1.9. Official bind is a single ImageView:
 * Super VIP → 概念VIP(svip) → 周卡(wvip) → 畅听VIP(tvip) → 季卡(qvip) →
 * vip_type / y_type / m_type music-pack fallback. They never stack.
 *
 * vinfo9.pic is the avatar-corner identity icon (达人 / 演唱者).
 * Other identity chips (学生 / …) stay next to the name.
 */

import type { CommentBadgeChip } from '@/models/comment';
import { isRecord, toRecord, type UnknownRecord } from '../../shared/object';

const parseIntSafe = (value: unknown): number => {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const numericPart = String(value).match(/^\d+/)?.[0];
  if (numericPart) return Number.parseInt(numericPart, 10) || 0;
  return Number.parseInt(String(value), 10) || 0;
};

const parseOptionalInt = (value: unknown): number | undefined => {
  if (value == null) return undefined;
  if (typeof value === 'number') return value;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const readString = (value: unknown, fallback = ''): string => {
  if (value == null) return fallback;
  return String(value);
};

const flag = (value: unknown): boolean =>
  value === true || value === 1 || parseIntSafe(value) === 1;

const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

export type CommentVipKind =
  | 'svip'
  | 'svip-year'
  | 'concept'
  | 'concept-year'
  | 'wvip'
  | 'changting'
  | 'qvip'
  | 'vip-year'
  | 'vip'
  | 'music-year'
  | 'music';

export type CommentIdentityKind = 'talent' | 'student' | 'actor' | 'biz' | 'tme-star';

export interface CommentBusiVip {
  productType: string;
  isVip: boolean;
  yType: number;
}

export interface CommentVipExt {
  userType: number;
  userYType: number;
  svipLevel: number;
  busiVip: CommentBusiVip[];
}

/** Official 达人 corner mark used when vinfo9 only sets the flag. */
export const COMMENT_TALENT_ICON =
  'https://imge.kugou.com/commendpic/20180627/20180627153930257837.png';

export interface CommentIdentity {
  talent: boolean;
  student: boolean;
  actor: boolean;
  biz: boolean;
  tmeStar: boolean;
  star: boolean;
  authInfo: string;
  userLabel: string;
  talentIcon: string;
}

export interface CommentVipFields {
  vipType: number;
  mType: number;
  yType: number;
  ext: CommentVipExt;
  identity: CommentIdentity;
}

export type { CommentBadgeChip };

const emptyExt = (): CommentVipExt => ({
  userType: -1,
  userYType: -1,
  svipLevel: -1,
  busiVip: [],
});

/** `o.p(mType, yType)` — music-pack kind. */
export const resolveMusicKind = (mType: number, yType: number): number => {
  if (yType === 1 || yType === 3) return 5;
  if (mType === 1 || mType === 2) return 3;
  return mType === 3 || mType === 4 ? 4 : -2;
};

/** Fallback plate from vip_type / m_type / y_type after BusiVip miss (`o.q` tail). */
export const resolveVipKind = (vipType: number, mType: number, yType: number): number => {
  if (yType === 2 || yType === 3) return 6;
  if (vipType === 1 || vipType === 2 || vipType === 3 || vipType === 4) {
    return mType > 0 ? 2 : 1;
  }
  return vipType === 6 ? 2 : -1;
};

export const resolveCompactVipKind = (vipType: number, mType: number, yType: number): number => {
  const kind = resolveVipKind(vipType, mType, yType);
  return kind === 2 && yType === 1 ? 6 : kind;
};

/**
 * `vippage.n.b(user_type)`: Super VIP is bit 16, not svip_level.
 * `n.a(type)` is type >= 0; `n.b` / `n.c` are `(type >= 0) && (type & 16) > 0`.
 * Using svip_level > 0 here hid every other Young plate.
 */
const hasSuperVipBit = (type: number): boolean => type >= 0 && (type & 16) > 0;

export const isSuperVipExt = (ext: CommentVipExt): boolean => hasSuperVipBit(ext.userType);

export const isYearSuperVipExt = (ext: CommentVipExt): boolean => hasSuperVipBit(ext.userYType);

const findActive = (items: CommentBusiVip[], type: string): CommentBusiVip | undefined =>
  items.find((item) => item.isVip && item.productType === type);

/**
 * `o.q(busiVip, vipType, mType, yType, svipExt)` — single plate id.
 * 10 super-year, 9 super, 8 young-svip-year, 7 young-svip, 13 wvip,
 * 11 tvip/畅听, 12 qvip, then classic vip/music kinds.
 */
export const resolveYoungPlateId = (
  vipType: number,
  mType: number,
  yType: number,
  ext: CommentVipExt = emptyExt(),
): number => {
  if (isSuperVipExt(ext)) return isYearSuperVipExt(ext) ? 10 : 9;
  const svip = findActive(ext.busiVip, 'svip');
  if (svip) return svip.yType === 1 ? 8 : 7;
  if (findActive(ext.busiVip, 'wvip')) return 13;
  if (findActive(ext.busiVip, 'tvip')) return 11;
  if (findActive(ext.busiVip, 'qvip')) return 12;
  if (yType === 2 || yType === 3) return 6;
  if (vipType === 1 || vipType === 2 || vipType === 3 || vipType === 4) {
    return mType > 0 ? 2 : 1;
  }
  return vipType === 6 ? 2 : -1;
};

/** `o.J(plateId, musicKind)` — ImageView visibility. */
export const shouldShowVipPlate = (
  plateId: number,
  musicKind: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ext?: CommentVipExt,
): boolean =>
  plateId === 7 ||
  plateId === 13 ||
  plateId === 11 ||
  plateId === 8 ||
  plateId === 2 ||
  plateId === 1 ||
  musicKind === 4 ||
  musicKind === 3 ||
  plateId === 6 ||
  musicKind === 5 ||
  plateId === 9 ||
  plateId === 12 ||
  plateId === 10;

/**
 * `o.w(plateId, musicKind)` drawable order, first match wins.
 * plateId=1 has no dedicated drawable but J() still shows the view → VIP chip.
 */
export const resolveCommentVipKind = (
  vipType: number,
  mType: number,
  yType: number,
  ext: CommentVipExt = emptyExt(),
): CommentVipKind | null => {
  const plateId = resolveYoungPlateId(vipType, mType, yType, ext);
  const musicKind = resolveMusicKind(mType, yType);
  if (!shouldShowVipPlate(plateId, musicKind, ext)) return null;
  if (plateId === 10) return 'svip-year';
  if (plateId === 9) return 'svip';
  if (plateId === 8) return 'concept-year';
  if (plateId === 7) return 'concept';
  if (plateId === 6) return 'vip-year';
  if (musicKind === 5) return 'music-year';
  if (plateId === 2) return 'vip';
  if (musicKind === 3 || musicKind === 4) return 'music';
  if (plateId === 13) return 'wvip';
  if (plateId === 11) return 'changting';
  if (plateId === 12) return 'qvip';
  if (plateId === 1) return 'vip';
  return null;
};

const VIP_LABEL: Record<CommentVipKind, string> = {
  svip: '超级VIP',
  'svip-year': '超级VIP',
  concept: '概念VIP',
  'concept-year': '概念VIP',
  wvip: '周卡',
  changting: '畅听VIP',
  qvip: '季卡',
  'vip-year': '豪华VIP',
  vip: 'VIP',
  'music-year': '年费音乐包',
  music: '音乐包',
};

const IDENTITY_CHIPS: Array<{
  flag: keyof CommentIdentity;
  kind: CommentIdentityKind;
  label: string;
}> = [
  { flag: 'student', kind: 'student', label: '学生' },
  { flag: 'actor', kind: 'actor', label: '演员' },
  { flag: 'biz', kind: 'biz', label: '认证' },
  { flag: 'tmeStar', kind: 'tme-star', label: '明星' },
];

const AVATAR_ICON_LABELS = new Set(['达人', '演唱者', '歌手']);

export const vipBadgeLabel = (kind: CommentVipKind): string => VIP_LABEL[kind];

export const commentVipChips = (fields: CommentVipFields): CommentBadgeChip[] => {
  const chips: CommentBadgeChip[] = [];
  const vip = resolveCommentVipKind(fields.vipType, fields.mType, fields.yType, fields.ext);
  if (vip) {
    chips.push({ key: `vip:${vip}`, label: vipBadgeLabel(vip), kind: vip });
  }
  const seen = new Set<string>(chips.map((chip) => chip.label));
  for (const item of IDENTITY_CHIPS) {
    if (!fields.identity[item.flag]) continue;
    chips.push({ key: `id:${item.kind}`, label: item.label, kind: item.kind });
    seen.add(item.label);
  }
  const auth = fields.identity.authInfo;
  if (auth && !seen.has(auth) && !AVATAR_ICON_LABELS.has(auth) && auth !== '学生') {
    chips.push({ key: `auth:${auth}`, label: auth, kind: 'auth' });
  }
  return chips;
};

const collectBusiVip = (record: UnknownRecord, vipinfo: UnknownRecord): unknown[] => {
  const buckets = [
    record.busi_vip,
    record.busiVip,
    vipinfo.busi_vip,
    asRecord(record.user).busi_vip,
  ];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) return bucket;
  }
  return [];
};

const looksLikeUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value) || value.startsWith('//');

const readHttpUrl = (value: unknown): string => {
  const url = readString(value, '').trim();
  if (!looksLikeUrl(url)) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url.replace(/^http:\/\//i, 'https://');
};

/** cmtlist `vinfo9.pic` — 达人 / 演唱者 corner mark. Empty string means none. */
const extractIdentityIconUrl = (record: UnknownRecord, vinfo9: UnknownRecord): string => {
  const extra = asRecord(record.extra);
  const candidates = [
    vinfo9.pic,
    vinfo9.t_pic,
    vinfo9.tpic,
    vinfo9.t_icon,
    record.t_pic,
    extra.t_pic,
  ];
  for (const candidate of candidates) {
    const url = readHttpUrl(candidate);
    if (url) return url;
  }
  return '';
};

export const resolveCommentTalentIcon = (identity: CommentIdentity): string => {
  if (identity.talentIcon) return identity.talentIcon;
  return identity.talent ? COMMENT_TALENT_ICON : '';
};

const mapBusiVip = (entry: unknown): CommentBusiVip | null => {
  const record = asRecord(entry);
  const productType = readString(record.product_type ?? record.productType, '')
    .trim()
    .toLowerCase();
  if (!productType) return null;
  return {
    productType,
    isVip: flag(record.is_vip ?? record.isVip),
    yType: parseIntSafe(record.y_type ?? record.yType),
  };
};

export const extractCommentVipFields = (item: unknown): CommentVipFields => {
  const record = toRecord(item);
  const vipinfo = asRecord(record.vipinfo);
  const vinfo9 = asRecord(record.vinfo9);
  const busiVip = collectBusiVip(record, vipinfo)
    .map(mapBusiVip)
    .filter((entry): entry is CommentBusiVip => entry !== null);
  const userType =
    parseOptionalInt(vipinfo.user_type ?? record.user_type ?? record.vip_user_type) ?? -1;
  const userYType =
    parseOptionalInt(vipinfo.user_y_type ?? record.user_y_type ?? record.vip_user_y_type) ?? -1;
  const svipLevel = parseOptionalInt(vipinfo.svip_level ?? record.svip_level) ?? -1;
  const talentIcon = extractIdentityIconUrl(record, vinfo9);
  const talent = flag(vinfo9.cmt_talent_status ?? record.cmt_talent_status);
  const star = flag(vinfo9.star_v_status ?? record.star_v_status);

  return {
    vipType: parseIntSafe(record.vip_type ?? record.vipType),
    mType: parseIntSafe(record.m_type ?? record.mType),
    yType: parseIntSafe(record.y_type ?? record.yType),
    ext: { userType, userYType, svipLevel, busiVip },
    identity: {
      talent,
      student: flag(vinfo9.student_status ?? record.student_status),
      actor: flag(vinfo9.actor_status ?? record.actor_status),
      biz: flag(vinfo9.biz_status ?? record.biz_status),
      tmeStar: flag(vinfo9.tme_star_status ?? record.tme_star_status),
      star,
      authInfo: readString(vinfo9.auth_info ?? record.auth_info, '').trim(),
      userLabel: readString(vinfo9.user_label ?? record.user_label, '').trim(),
      talentIcon,
    },
  };
};

export const commentChipsFromRaw = (item: unknown): CommentBadgeChip[] =>
  commentVipChips(extractCommentVipFields(item));

export const commentTalentIconFromRaw = (item: unknown): string =>
  resolveCommentTalentIcon(extractCommentVipFields(item).identity);
