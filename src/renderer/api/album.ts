import request from '@/utils/request';

/** 专辑动态封面（短视频），缺少专辑 ID 时仍可按专辑音乐 ID 查询。 */
export function getAlbumDynamicCover(albumAudioId: string, albumId?: string) {
  return request.get('/album/dycover', {
    params: {
      album_audio_id: albumAudioId,
      ...(albumId ? { album_id: albumId } : {}),
    },
    // Artwork is optional and must not interrupt playback with a verification dialog.
    skipKugouVerification: true,
  });
}

/**
 * 获取专辑详情
 */
export function getAlbumDetail(id: string | number) {
  return request.get('/album/detail', {
    params: { id },
  });
}

/**
 * 获取专辑歌曲
 */
export function getAlbumSongs(id: string | number, page = 1, pagesize = 30) {
  return request.get('/album/songs', {
    params: { id, page, pagesize },
  });
}

/**
 * 收藏专辑
 */
export function favoriteAlbum(id: string | number, name: string, singerId?: number) {
  return request.get('/playlist/add', {
    params: {
      name,
      is_pri: 0,
      type: 1,
      source: 2,
      ...(singerId !== undefined ? { list_create_userid: singerId } : {}),
      list_create_listid: id,
    },
  });
}

/** 专辑内容类别：'1' 音乐专辑，'2' 有声 */
export type AlbumCategory = '1' | '2';

const ALBUM_CATEGORY_CHUNK = 50;

/** 服务端子模块未带 /album/batch 时只提示一次，之后全部按音乐专辑处理 */
let batchEndpointMissing = false;

/**
 * 取消收藏专辑
 */
export function unfavoriteAlbum(listid: string | number) {
  return request.get('/playlist/del', {
    params: { listid },
  });
}

/**
 * 批量回查专辑内容类别（收藏列表接口不返回类别）
 * 返回 专辑 ID → 类别；查不到的 ID 不在映射里，调用方按音乐专辑处理。
 * 服务端还没升级到带 /album/batch 的子模块时静默降级，不影响收藏页展示。
 */
export async function getAlbumCategories(
  ids: (string | number)[],
): Promise<Map<string, AlbumCategory>> {
  const categories = new Map<string, AlbumCategory>();
  const uniqueIds = Array.from(new Set(ids.map((id) => String(id)).filter((id) => id.length > 0)));

  for (let start = 0; start < uniqueIds.length; start += ALBUM_CATEGORY_CHUNK) {
    const chunk = uniqueIds.slice(start, start + ALBUM_CATEGORY_CHUNK);
    try {
      const res = await request.get('/album/batch', {
        params: { ids: chunk.join(',') },
        skipKugouVerification: true,
      });
      const list = Array.isArray(res?.data)
        ? res.data
        : Array.isArray(res?.data?.data)
          ? res.data.data
          : [];
      for (const item of list as Array<Record<string, unknown>>) {
        const id = String(item?.album_id ?? '');
        const category = String(item?.category ?? '');
        if (id && (category === '1' || category === '2')) categories.set(id, category);
      }
    } catch (error) {
      if (!batchEndpointMissing) {
        batchEndpointMissing = true;
        console.warn('[album] 批量类别接口不可用，专辑暂按音乐专辑处理', error);
      }
      break;
    }
  }

  return categories;
}
