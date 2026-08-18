import request from '@/utils/request';

export const getChannelSongs = (channelId: string, page = 1, pageSize = 20) =>
  request.get('/youth/channel/song/list', {
    params: {
      global_collection_id: channelId,
      page,
      pagesize: pageSize,
    },
  });
