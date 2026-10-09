import { watch, type WatchCallback, type WatchOptions } from 'vue';
import { userSessionSources, type UserSession } from './userSession';

export type UserSessionSnapshot = {
  isLoggedIn: boolean;
  accountRevision: number;
  userId: string;
  token: string | undefined;
};

type SessionValues = readonly [boolean, number, string, string | undefined];
const snapshot = ([
  isLoggedIn,
  accountRevision,
  userId,
  token,
]: SessionValues): UserSessionSnapshot => ({ isLoggedIn, accountRevision, userId, token });

/**
 * 业务只注册会话变化后的清理/刷新；字段判定与 captureUserSession 保持一致。
 * 和 Vue watch 一样自动随 effect scope 释放，并返回可显式停止的 handle。
 * 清理旧状态用 flush: 'sync'；刷新请求保留默认批处理，避免读到 $patch 的中间身份。
 * 混合资源、路由等条件的 watcher 可直接复用 userSessionSources。
 */
export const watchUserSession = (
  user: UserSession,
  callback: WatchCallback<UserSessionSnapshot, UserSessionSnapshot | undefined>,
  options?: WatchOptions<boolean>,
) =>
  watch(
    userSessionSources(user),
    (current, previous, onCleanup) =>
      callback(
        snapshot(current),
        previous.length ? snapshot(previous as SessionValues) : undefined,
        onCleanup,
      ),
    options,
  );
