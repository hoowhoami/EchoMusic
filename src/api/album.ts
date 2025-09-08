import { api } from '@/utils/request';

// 专辑详情
// 说明: 调用此接口 ,传入专辑 id 可获取专辑详情
// 必选参数：
// id: 专辑 id
export const getAlbumDetail = (id: number) => {
  return api.get('/album/detail', { id });
};
