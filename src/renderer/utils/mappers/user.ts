import type { UserPatch } from '@/models/user';
import {
  EMPTY_RECORD,
  getRecord,
  parseIntSafe,
  parseOptionalInt,
  pickValue,
  readString,
  toRecord,
  isRecord,
} from './shared';

export const mapUser = (json: unknown): UserPatch => {
  const record = toRecord(json);
  const data = getRecord(record, 'data') ?? EMPTY_RECORD;
  const info = getRecord(record, 'info') ?? EMPTY_RECORD;
  const userInfo = getRecord(record, 'userinfo') ?? getRecord(record, 'user_info') ?? EMPTY_RECORD;
  const profile = getRecord(record, 'profile') ?? EMPTY_RECORD;
  const account = getRecord(record, 'account') ?? EMPTY_RECORD;
  const primary =
    Object.keys(userInfo).length > 0
      ? userInfo
      : Object.keys(profile).length > 0
        ? profile
        : Object.keys(info).length > 0
          ? info
          : Object.keys(data).length > 0
            ? data
            : record;

  const extendsInfo = isRecord(record.extends)
    ? record.extends
    : isRecord(record.extendsInfo)
      ? record.extendsInfo
      : isRecord(primary.extends)
        ? primary.extends
        : isRecord(primary.extendsInfo)
          ? primary.extendsInfo
          : EMPTY_RECORD;

  const detail =
    getRecord(record, 'detail') ?? getRecord(primary, 'detail') ?? getRecord(extendsInfo, 'detail');
  const vip =
    getRecord(record, 'vip') ?? getRecord(primary, 'vip') ?? getRecord(extendsInfo, 'vip');

  const useridRaw = pickValue(
    record.userid,
    record.userId,
    record.user_id,
    record.uid,
    record.id,
    primary.userid,
    primary.userId,
    primary.user_id,
    primary.uid,
    primary.id,
    account.userid,
    account.userId,
    account.user_id,
    account.uid,
    account.id,
    detail?.userid,
    detail?.userId,
    detail?.user_id,
    detail?.uid,
    detail?.id,
  );
  const userid = useridRaw !== undefined ? parseIntSafe(useridRaw) : undefined;

  const token = readString(pickValue(record.token, primary.token, account.token), '').trim();
  const username = readString(
    pickValue(
      primary.username,
      primary.userName,
      record.username,
      record.userName,
      account.username,
    ),
    '',
  ).trim();
  const nickname = readString(
    pickValue(
      primary.nickname,
      primary.userName,
      primary.username,
      record.nickname,
      record.userName,
      username,
    ),
    '',
  ).trim();
  const pic = readString(
    pickValue(
      primary.pic,
      primary.userPic,
      primary.avatar,
      profile.avatarUrl,
      profile.avatar,
      record.pic,
      record.userPic,
      record.avatar,
    ),
    '',
  ).trim();
  const mobile = readString(pickValue(primary.mobile, record.mobile, account.mobile), '').trim();
  const t1 = readString(pickValue(record.t1, primary.t1, account.t1), '').trim();
  const expiresRaw = pickValue(primary.expires, record.expires, account.expires);
  const vipTypeRaw = pickValue(primary.vip_type, record.vip_type, vip?.vip_type);
  const pGradeRaw = pickValue(primary.p_grade, record.p_grade, detail?.p_grade);
  const expires = expiresRaw !== undefined ? parseOptionalInt(expiresRaw) : undefined;
  const vipType = vipTypeRaw !== undefined ? parseOptionalInt(vipTypeRaw) : undefined;
  const pGrade = pGradeRaw !== undefined ? parseOptionalInt(pGradeRaw) : undefined;
  const mergedExtends =
    Object.keys(extendsInfo).length > 0 || detail || vip
      ? {
          ...extendsInfo,
          ...(detail ? { detail } : {}),
          ...(vip ? { vip } : {}),
        }
      : undefined;

  const patch: UserPatch = {};
  if (typeof userid === 'number' && userid > 0) {
    patch.userid = userid;
    patch.userId = userid;
  }
  if (token) patch.token = token;
  if (username) patch.username = username;
  if (nickname || username) {
    patch.nickname = nickname || username;
    patch.userName = nickname || username;
  }
  if (mobile) patch.mobile = mobile;
  if (pic) {
    patch.pic = pic;
    patch.userPic = pic;
  }
  if (t1) patch.t1 = t1;
  if (typeof expires === 'number' && expires > 0) patch.expires = expires;
  if (typeof vipType === 'number') patch.vip_type = vipType;
  if (typeof pGrade === 'number') patch.p_grade = pGrade;
  if (detail) patch.detail = detail;
  if (vip) patch.vip = vip;
  if (mergedExtends) {
    patch.extends = mergedExtends;
    patch.extendsInfo = mergedExtends;
  }

  return patch;
};
