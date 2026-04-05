export function getCoverUrl(url: string | undefined, size: number = 400): string {
  if (!url || url === '') {
    return 'https://imge.kugou.com/soft/collection/default.jpg';
  }

  let cover = url.replace('http://', 'https://');
  return cover.replace('{size}', size.toString()).replace('c1.kgimg.com', 'imge.kugou.com');
}
