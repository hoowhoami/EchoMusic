import { toRecord } from '../../shared/object';
import { COMMENT_TALENT_ICON, commentChipsFromRaw, commentTalentIconFromRaw } from './commentVip';
import { getAccountVipStatus, getPrimaryVipBadge } from './accountVip';

export interface UserIdentityBadge {
  key: string;
  label: string;
  kind: 'membership' | 'identity' | 'auth' | 'talent' | 'student';
}

// Official social talent bit order (kj1.b); reserved bits have no display label.
const TALENT_LABELS = [
  '歌单达人',
  '评论达人',
  '调音师',
  '酷狗号',
  '问答达人',
  '歌词制作达人',
  '音频主播',
  '直播达人',
  'K歌达人',
  '短视频达人',
  '鱼声主播',
  '',
  '',
  '专栏作家',
  '视频达人',
  '音乐画报达人',
];
const SINGER_ICON = 'https://imge.kugou.com/commendpic/20180627/20180627153852371280.png';
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const active = (value: unknown) => value === true || Number(value) === 1;
const labels = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(labels)
    : text(value)
        .split(/[,，、;；\n]+/)
        .map((item) => item.trim())
        .filter(Boolean);

export function getUserIdentity(value: unknown, includeMembership = false) {
  const root = toRecord(value);
  const record = {
    ...toRecord(root.user),
    ...toRecord(root.profile),
    ...toRecord(root.info),
    ...toRecord(root.friend),
    ...toRecord(root.fans),
    ...toRecord(root.visitor),
    ...root,
  };
  const vinfo = { ...record, ...toRecord(record.vinfo9) };
  const badges: UserIdentityBadge[] = [];
  const seen = new Set<string>();
  const add = (label: string, kind: UserIdentityBadge['kind']) => {
    if (!label || seen.has(label)) return;
    seen.add(label);
    badges.push({ key: `${kind}:${label}`, label, kind });
  };
  if (includeMembership) {
    const vip = { ...record, ...toRecord(record.vipinfo), ...toRecord(record.vip) };
    const primary = getPrimaryVipBadge(getAccountVipStatus(vip));
    const fallback = commentChipsFromRaw(vip).find((chip) => chip.key.startsWith('vip:'));
    add(primary?.label ?? fallback?.label ?? '', 'membership');
  }
  if (active(vinfo.student_status)) add('学生', 'student');
  if (active(vinfo.actor_status)) add('演员', 'identity');
  if (active(vinfo.biz_status)) add('认证', 'identity');
  if (active(vinfo.tme_star_status)) add('明星', 'identity');
  const singer =
    active(vinfo.singer_status) || active(vinfo.star_v_status) || active(vinfo.is_star);
  if (singer) add('歌手', 'identity');
  for (const key of ['auth_info', 'auth_info_talent', 'auth_info_singer', 'kq_talent_desc']) {
    for (const label of labels(vinfo[key])) add(label, 'auth');
  }
  const talent = Number(vinfo.kq_talent);
  const hasTalentDescription =
    Boolean(text(vinfo.auth_info_talent) || text(vinfo.kq_talent_desc)) ||
    labels(vinfo.auth_info).some((label) => /达人|主播|调音师|酷狗号|专栏作家/.test(label));
  if (Number.isSafeInteger(talent) && talent > 0 && !hasTalentDescription) {
    TALENT_LABELS.forEach((label, bit) => {
      if ((talent & (2 ** bit)) !== 0) add(label, 'talent');
    });
  }
  const hasTalent = active(vinfo.cmt_talent_status) || (Number.isSafeInteger(talent) && talent > 0);
  if (
    hasTalent &&
    !badges.some((badge) => badge.kind === 'talent' || badge.label.includes('达人'))
  ) {
    add('达人', 'talent');
  }
  const avatarIcon =
    commentTalentIconFromRaw(record) ||
    (singer ? SINGER_ICON : hasTalent ? COMMENT_TALENT_ICON : '');
  return {
    badges,
    avatarIcon,
    avatarLabel: singer ? '歌手认证' : '达人',
    tags: [...new Set(labels(record.tags))],
    studentSchool: active(vinfo.student_status) ? text(vinfo.student_school) : '',
    studentExpireTime: active(vinfo.student_status) ? text(vinfo.student_expire_time) : '',
  };
}

export function getAccountIdentity(value: unknown) {
  const root = toRecord(value);
  const extra = toRecord(root.extendsInfo ?? root.extends);
  return getUserIdentity({
    ...toRecord(root.detail ?? extra.detail),
    ...toRecord(extra.identity),
  });
}

/** Small display-only snapshot for saved accounts; never contains raw profile or credentials. */
export function getAccountDisplay(value: unknown) {
  const root = toRecord(value);
  const extra = toRecord(root.extendsInfo ?? root.extends);
  const { badges, avatarIcon, avatarLabel, tags } = getAccountIdentity(value);
  return {
    badges,
    avatarIcon,
    avatarLabel,
    tags,
    membership: getPrimaryVipBadge(getAccountVipStatus(root.vip ?? extra.vip)),
  };
}

export type AccountDisplay = ReturnType<typeof getAccountDisplay>;

export function hasAccountDisplayData(value: unknown): boolean {
  const root = toRecord(value);
  const extra = toRecord(root.extendsInfo ?? root.extends);
  const detail = toRecord(root.detail ?? extra.detail);
  const vip = toRecord(root.vip ?? extra.vip);
  return (
    [
      'kq_talent',
      'auth_info',
      'biz_status',
      'singer_status',
      'actor_status',
      'tme_star_status',
      'student_status',
    ].some((key) => key in detail) ||
    'identity' in extra ||
    ['vip_type', 'user_type', 'busi_vip', 'm_type', 'y_type'].some((key) => key in vip)
  );
}
