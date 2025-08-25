import { api } from '@/utils/request';

export const getPlaylist = (page: number = 1, pagesize: number = 100) => {
  return api.get('/user/playlist', { page, pagesize });
};
