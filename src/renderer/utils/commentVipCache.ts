import { getBatchUnionVipinfo } from '@/api/user';
import { commentChipsFromRaw, commentTalentIconFromRaw } from '@/utils/commentVip';
import type { Comment } from '@/models/comment';
import { isRecord, toRecord } from '../../shared/object';

const cache = new Map<string, unknown[]>();
const inflight = new Map<string, Promise<void>>();

const commentUserId = (comment: Comment): string => {
  const raw = comment.raw && typeof comment.raw === 'object' ? comment.raw : {};
  const value = comment.userId ?? raw.user_id ?? raw.userid ?? raw.uid;
  const id = String(value ?? '').trim();
  if (!id || id === '0') return '';
  return /^\d+$/.test(id) ? id : '';
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const parseBusiVipMap = (payload: unknown): Record<string, unknown[]> => {
  const record = toRecord(payload);
  const data = isRecord(record.data) ? record.data : record;
  const busi = isRecord(data.busi_vip)
    ? data.busi_vip
    : isRecord(record.busi_vip)
      ? record.busi_vip
      : {};
  const result: Record<string, unknown[]> = {};
  for (const [key, value] of Object.entries(busi)) {
    const id = String(key).trim();
    if (!id) continue;
    result[id] = asArray(value);
  }
  return result;
};

const fetchChunk = async (userIds: string[]): Promise<void> => {
  if (userIds.length === 0) return;
  try {
    const response = await getBatchUnionVipinfo(userIds);
    const mapped = parseBusiVipMap(response);
    for (const id of userIds) {
      cache.set(id, mapped[id] ?? []);
    }
  } catch {
    for (const id of userIds) {
      if (!cache.has(id)) cache.set(id, []);
    }
  }
};

const ensureUserIds = async (userIds: string[]): Promise<void> => {
  const missing = [...new Set(userIds)].filter((id) => id && !cache.has(id));
  if (missing.length === 0) return;
  const pending: Promise<void>[] = [];
  for (let index = 0; index < missing.length; index += 20) {
    const chunk = missing.slice(index, index + 20);
    const key = chunk.join(',');
    let task = inflight.get(key);
    if (!task) {
      task = fetchChunk(chunk).finally(() => inflight.delete(key));
      inflight.set(key, task);
    }
    pending.push(task);
  }
  await Promise.all(pending);
};

const attachCachedVip = (comment: Comment): Comment => {
  const userId = commentUserId(comment);
  if (!userId) return comment;
  const busiVip = cache.get(userId);
  if (!busiVip) return comment;
  const raw = { ...(comment.raw ?? {}), busi_vip: busiVip, user_id: userId };
  const badges = commentChipsFromRaw(raw);
  const talentIcon = commentTalentIconFromRaw(raw);
  return {
    ...comment,
    userId,
    raw,
    badges: badges.length > 0 ? badges : undefined,
    talentIcon: talentIcon || undefined,
  };
};

/** Young `d1.g`: batch-fill BusiVip for comment authors, then rebuild badges. */
export const enrichCommentsWithYoungVip = async (comments: Comment[]): Promise<Comment[]> => {
  if (comments.length === 0) return comments;
  const userIds = comments.map(commentUserId).filter(Boolean);
  await ensureUserIds(userIds);
  return comments.map(attachCachedVip);
};
