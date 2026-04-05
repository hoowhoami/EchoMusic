import request from '@/utils/request';

/**
 * 搜索
 */
export function search(keywords: string, type = 'song', page = 1, pagesize = 30) {
  return request.get('/search', {
    params: { keywords, type, page, pagesize }
  });
}

/**
 * 获取搜索热词
 */
export function getSearchHot() {
  return request.get('/search/hot');
}

/**
 * 获取默认搜索词
 */
export function getSearchDefault() {
  return request.get('/search/default');
}

/**
 * 获取搜索建议
 */
export function getSearchSuggest(keywords: string) {
  return request.get('/search/suggest', {
    params: { keywords }
  });
}
