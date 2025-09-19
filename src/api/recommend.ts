import { api } from '@/utils/request';

// 每日推荐
// 说明：调用此接口，可以获取每日推荐列表
// 可选参数：
// platform：设备类型，默认为 ios,支持 android 和 ios
export const getEverydayRecommend = (platform: 'android' | 'ios' = 'ios') => {
  return api.get('/everyday/recommend', {
    platform,
  });
};
