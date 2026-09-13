interface OwnedPlaylistContext {
  currentUserId?: number;
  listCreateUserid?: number;
  listCreateGid?: string;
  listCreateListid?: number;
  /** 仅传 /user/playlist 返回的 listid，不能传详情接口的公开 specialid。 */
  listid?: number;
  source?: number;
}

/** 新接口只接受当前账号的云歌单 listid，公开歌单 ID 不可替代。 */
export function resolveOwnedPlaylistListId(
  fallbackId: string | number,
  context: OwnedPlaylistContext,
): number | null {
  const userId = Number(context.currentUserId);
  if (!Number.isSafeInteger(userId) || userId <= 0 || context.source === 2) return null;
  const positiveId = (value: unknown) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  for (const value of [context.listCreateGid, fallbackId]) {
    const match = /^collection_3_(\d+)_(\d+)_\d+$/.exec(String(value ?? ''));
    if (match && Number(match[1]) === userId) return positiveId(match[2]);
  }
  if (Number(context.listCreateUserid) !== userId) return null;
  return positiveId(context.listid) ?? positiveId(context.listCreateListid);
}
