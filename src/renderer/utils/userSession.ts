export type UserSession = {
  isLoggedIn: boolean;
  accountRevision: number;
  info: { userid?: string | number; userId?: string | number; token?: string } | null;
};

/** 会话身份的统一来源；资料、头像和会员字段更新不构成账号切换。 */
export const userSessionSources = (user: UserSession) =>
  [
    () => user.isLoggedIn,
    () => user.accountRevision,
    () => String(user.info?.userid ?? user.info?.userId ?? ''),
    () => user.info?.token,
  ] as const;

/** 捕获会话值，避免对象原地更新或同账号重新登录使旧操作继续生效。 */
export const captureUserSession = (user: UserSession): (() => boolean) => {
  const sources = userSessionSources(user);
  const values = sources.map((read) => read());
  return () => sources.every((read, index) => read() === values[index]);
};
