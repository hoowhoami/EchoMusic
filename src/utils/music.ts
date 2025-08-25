export const getCover = (coverUrl: string, size: number = 200) => {
  if (!coverUrl) return './assets/images/ico.png';
  return coverUrl
    .replace('{size}', `${size}`)
    .replace('http://', 'https://')
    .replace('c1.kgimg.com', 'imge.kugou.com');
};
