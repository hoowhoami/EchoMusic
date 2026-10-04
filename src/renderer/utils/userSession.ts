type UserSession = {
  isLoggedIn: boolean;
  accountRevision: number;
  info: { userid?: string | number; userId?: string | number; token?: string } | null;
};

/** 捕获会话值，避免对象原地更新或同账号重新登录使旧操作继续生效。 */
export const captureUserSession = (user: UserSession): (() => boolean) => {
  const revision = user.accountRevision;
  const loggedIn = user.isLoggedIn;
  const userId = String(user.info?.userid ?? user.info?.userId ?? '');
  const token = user.info?.token;
  return () =>
    user.accountRevision === revision &&
    user.isLoggedIn === loggedIn &&
    String(user.info?.userid ?? user.info?.userId ?? '') === userId &&
    user.info?.token === token;
};
