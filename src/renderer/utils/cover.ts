export function getCoverUrl(url: string | undefined, size: number = 400): string {
  if (!url || url === '') {
    return 'https://imge.kugou.com/soft/collection/default.jpg';
  }

  let cover = url.replace('http://', 'https://');

  // 如果 URL 包含 {size} 占位符，替换为指定尺寸
  if (cover.includes('{size}')) {
    cover = cover.replace('{size}', size.toString());
  }
  // 如果 URL 不包含 {size}，保持原样，不添加尺寸参数
  // 因为很多图片服务器不支持通过查询参数调整尺寸

  // 替换旧域名
  return cover.replace('c1.kgimg.com', 'imge.kugou.com');
}
