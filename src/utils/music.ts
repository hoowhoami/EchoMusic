import { Song } from '@/types';

export const getCover = (coverUrl: string, size: number = 200, https = true) => {
  if (!coverUrl) return 'https://imge.kugou.com/soft/collection/default.jpg';
  let cover = coverUrl;
  if (https) {
    cover = cover.replace('http://', 'https://');
  }
  return cover.replace(/{size}/g, `${size}`).replace('c1.kgimg.com', 'imge.kugou.com');
};

// 模糊搜索
export const fuzzySearch = (keyword: string, data: Song[]): Song[] => {
  try {
    const result: Song[] = [];
    const regex = new RegExp(keyword, 'i');

    /**
     * 递归函数：遍历对象及其嵌套属性，过滤包含关键词的对象
     * @param {Object} obj - 要检查的对象
     * @returns {boolean} - 如果找到匹配的属性值，返回 true；否则返回 false
     */
    const searchInObject = (obj: any): boolean => {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const value = obj[key];
          // 如果属性值是对象，则递归调用
          if (typeof value === 'object' && value !== null) {
            if (searchInObject(value)) {
              return true;
            }
          }
          // 检查属性值是否是字符串并包含关键词
          if (value && typeof value === 'string' && regex.test(value)) {
            return true;
          }
        }
      }
      return false;
    };

    if (!data) return [];

    // 如果传入的是数组，遍历数组
    if (Array.isArray(data)) {
      for (const item of data) {
        if (searchInObject(item)) {
          result.push(item);
        }
      }
    } else {
      // 如果传入的是对象，直接调用递归函数
      if (searchInObject(data)) {
        result.push(data);
      }
    }

    return result;
  } catch (error) {
    console.error('模糊搜索出现错误：', error);
    return [];
  }
};
