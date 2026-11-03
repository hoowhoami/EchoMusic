import type { UserPatch } from '@/models/user';
import { mapUser } from '@/utils/mappers';

/** 鉴权头中与账号凭证相关的字段，其余设备字段在导入时忽略。 */
const ACCOUNT_FIELD_ALIASES: Record<string, keyof UserPatch> = {
  userid: 'userid',
  user_id: 'userid',
  uid: 'userid',
  token: 'token',
  t1: 't1',
  nickname: 'nickname',
  username: 'nickname',
  user_name: 'nickname',
  pic: 'pic',
  userpic: 'pic',
  avatar: 'pic',
  expires: 'expires',
};

const stripAuthPrefix = (text: string) =>
  text.replace(/^\s*(?:authorization|cookie)\s*[:：]\s*/i, '');

const parseAuthFields = (text: string): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const part of text.split(/[;\n\r]+/)) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    const target = ACCOUNT_FIELD_ALIASES[key];
    if (!target || !value) continue;
    fields[target] = value;
  }
  return fields;
};

/**
 * 解析导入的账号信息：支持鉴权头 `key=value;...` 与 JSON。
 * 返回经 mapUser 归一化后的账号补丁，缺少有效 userid/token 时抛出可展示的错误。
 */
export const parseAccountImport = (text: string): UserPatch => {
  const raw = text.replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('请先粘贴要导入的用户信息');

  let payload: Record<string, unknown>;
  if (raw.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('JSON 格式不正确，请检查后重试');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('导入内容需为 JSON 对象');
    }
    payload = parsed as Record<string, unknown>;
  } else {
    payload = parseAuthFields(stripAuthPrefix(raw));
  }

  const mapped = mapUser(payload);
  if (
    !mapped.userid ||
    !Number.isSafeInteger(mapped.userid) ||
    mapped.userid <= 0 ||
    !mapped.token
  ) {
    throw new Error('导入信息不完整，需包含有效的 userid 与 token');
  }
  return mapped;
};
