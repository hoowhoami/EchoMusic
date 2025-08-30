import { api } from '@/utils/request';

export const getSongUrl = (hash: string) => {
  return api.get('/song/url', { hash });
};

export const getSongClimax = (hash: string) => {
  return api.get('/song/climax', { hash });
};
