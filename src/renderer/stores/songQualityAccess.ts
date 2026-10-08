import { defineStore } from 'pinia';
import { shallowRef, watch } from 'vue';
import { getSongPrivilegeLite } from '@/api/music';
import { getYouthUnionVip } from '@/api/user';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
import {
  parseSongQualityAccess,
  parseQualityMembership,
  type SongQualityAccess,
  type QualityMembership,
} from '@/utils/songQualityAccess';

interface Entry {
  status: 'loading' | 'ready' | 'error';
  qualities: SongQualityAccess[];
  updatedAt: number;
  payload?: unknown;
}
const CACHE_TTL = 30_000;
const CACHE_LIMIT = 100;
export const songQualityResourceKey = (hash: string, albumId?: string | number) =>
  JSON.stringify([hash.trim().toLowerCase(), String(albumId ?? '')]);

/** 账号权益不落入 Song/歌单持久化；同一账号的多播放器弹窗共享请求。 */
export const useSongQualityAccessStore = defineStore('songQualityAccess', () => {
  const user = useUserStore();
  const entries = shallowRef(new Map<string, Entry>());
  const membership = shallowRef<QualityMembership | null>(null);
  const membershipStatus = shallowRef<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const sessionRevision = shallowRef(0);
  let membershipUpdatedAt = 0;
  let membershipRequest: Promise<void> | null = null;
  let cachedUserInfoRevision = user.userInfoRevision;
  const pending = new Map<string, Promise<unknown>>();
  const clearCache = () => {
    entries.value = new Map();
    membership.value = null;
    membershipStatus.value = 'idle';
    membershipUpdatedAt = 0;
    membershipRequest = null;
    pending.clear();
    cachedUserInfoRevision = user.userInfoRevision;
  };
  watch(
    [
      () => user.accountRevision,
      () => user.isLoggedIn,
      () => user.info?.userid ?? user.info?.userId,
      () => user.info?.token,
    ],
    () => {
      sessionRevision.value += 1;
      clearCache();
    },
    { flush: 'sync' },
  );
  const captureAccessRequest = () => {
    const revision = user.userInfoRevision;
    const isSameSession = captureUserSession(user);
    return () => revision === user.userInfoRevision && isSameSession();
  };
  const put = (key: string, entry: Entry) => {
    const next = new Map(entries.value);
    next.delete(key);
    next.set(key, entry);
    if (next.size > CACHE_LIMIT) next.delete(next.keys().next().value!);
    entries.value = next;
  };
  const ensureMembership = (): Promise<void> => {
    if (!user.isLoggedIn) {
      membership.value = { concept: false, superVip: false };
      membershipStatus.value = 'ready';
      return Promise.resolve();
    }
    if (membershipRequest) return membershipRequest;
    if (membershipStatus.value === 'ready' && Date.now() - membershipUpdatedAt < CACHE_TTL)
      return Promise.resolve();
    const isCurrent = captureAccessRequest();
    membershipStatus.value = 'loading';
    const task = (async () => {
      try {
        const result = parseQualityMembership(await getYouthUnionVip());
        if (!isCurrent()) return;
        if (!result) throw new Error('会员权益响应不完整');
        membership.value = result;
        membershipUpdatedAt = Date.now();
        membershipStatus.value = 'ready';
      } catch {
        if (isCurrent()) {
          membership.value = null;
          membershipStatus.value = 'error';
        }
      } finally {
        if (isCurrent()) membershipRequest = null;
      }
    })();
    membershipRequest = task;
    return task;
  };
  const ensure = async (hash: string, albumId?: string | number, force = false) => {
    if (!hash.trim()) return;
    // 个人信息刷新只在下一次查询时失效缓存，不联动已打开的弹窗。
    if (cachedUserInfoRevision !== user.userInfoRevision) clearCache();
    const key = songQualityResourceKey(hash, albumId);
    const current = entries.value.get(key);
    const membershipTask = ensureMembership();
    if (pending.has(key)) {
      const [payload] = await Promise.all([pending.get(key), membershipTask]);
      return payload;
    }
    if (!force && current?.status === 'ready' && Date.now() - current.updatedAt < CACHE_TTL) {
      await membershipTask;
      return current.payload;
    }
    const isCurrent = captureAccessRequest();
    // 同一歌曲重查时保留展示内容；交互仍由 loading 状态锁定。
    put(key, { status: 'loading', qualities: current?.qualities ?? [], updatedAt: 0 });
    const task = (async () => {
      try {
        const payload = await getSongPrivilegeLite(hash, albumId);
        const result = parseSongQualityAccess(payload, hash);
        if (!isCurrent()) return;
        if (result?.length) {
          put(key, { status: 'ready', qualities: result, updatedAt: Date.now(), payload });
        } else {
          put(key, { status: 'error', qualities: [], updatedAt: 0 });
        }
        return payload;
      } catch {
        if (isCurrent()) put(key, { status: 'error', qualities: [], updatedAt: 0 });
      } finally {
        if (isCurrent()) pending.delete(key);
      }
    })();
    pending.set(key, task);
    const [payload] = await Promise.all([task, membershipTask]);
    return payload;
  };
  return { entries, membership, membershipStatus, sessionRevision, ensure, captureAccessRequest };
});
