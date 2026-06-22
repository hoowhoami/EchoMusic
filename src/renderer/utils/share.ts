import type { Router } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { buildShareText, type ShareResourceType, type ShareTarget } from '../../shared/share';

export const SHARE_COPIED_EVENT = 'echomusic:share-copied';

const cleanId = (value: unknown) => String(value ?? '').trim();

const readNestedText = (record: Record<string, unknown> | undefined, key: string) => {
  const value = record?.[key];
  return typeof value === 'string' ? value.trim() : '';
};

const getCurrentSharerName = () => {
  const userStore = useUserStore();
  const info = userStore.info;
  if (!info) return 'EchoMusic';

  const detail =
    info.detail && typeof info.detail === 'object'
      ? (info.detail as Record<string, unknown>)
      : undefined;
  const extendsDetail =
    info.extendsInfo?.detail && typeof info.extendsInfo.detail === 'object'
      ? (info.extendsInfo.detail as Record<string, unknown>)
      : undefined;

  return (
    info.nickname?.trim() ||
    info.username?.trim() ||
    info.userName?.trim() ||
    readNestedText(detail, 'nickname') ||
    readNestedText(detail, 'username') ||
    readNestedText(extendsDetail, 'nickname') ||
    readNestedText(extendsDetail, 'username') ||
    'EchoMusic'
  );
};

export const createShareTarget = (
  type: ShareResourceType,
  id: string | number | null | undefined,
  title?: string,
): ShareTarget | null => {
  const resolvedId = cleanId(id);
  if (!resolvedId) return null;
  return {
    type,
    id: resolvedId,
    ...(title?.trim() ? { title: title.trim() } : {}),
  };
};

export const copyShareTarget = async (target: ShareTarget): Promise<boolean> => {
  const text = buildShareText({
    ...target,
    sharer: target.sharer || getCurrentSharerName(),
  });
  let copied = false;
  if (window.electron?.share?.copy) {
    copied = await window.electron.share.copy(text);
  } else {
    await navigator.clipboard.writeText(text);
    copied = true;
  }
  if (copied) {
    window.dispatchEvent(
      new CustomEvent<ShareTarget>(SHARE_COPIED_EVENT, {
        detail: target,
      }),
    );
  }
  return copied;
};

export const navigateToShareTarget = (router: Router, target: ShareTarget) => {
  const id = cleanId(target.id);
  if (!id) return false;

  if (target.type === 'song') {
    void router.push({
      name: 'song-detail',
      params: { id },
      query: {
        mainTab: 'detail',
        type: 'music',
        mixSongId: id,
      },
    });
    return true;
  }

  const routeNames: Record<Exclude<ShareResourceType, 'song'>, string> = {
    playlist: 'playlist-detail',
    artist: 'artist-detail',
    album: 'album-detail',
  };

  void router.push({
    name: routeNames[target.type],
    params: { id },
  });
  return true;
};
