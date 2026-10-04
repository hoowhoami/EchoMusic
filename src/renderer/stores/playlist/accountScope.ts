import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';

/** 账号重置及同账号重新登录都会使进行中的集合操作失效。 */
export const captureCollectionScope = (store: { userCollectionsGeneration: number }) => {
  const generation = store.userCollectionsGeneration;
  const isCurrentSession = captureUserSession(useUserStore());
  return () => store.userCollectionsGeneration === generation && isCurrentSession();
};
