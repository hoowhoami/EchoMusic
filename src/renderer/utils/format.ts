/**
 * 格式化时间戳 (秒) 为日期字符串
 */
export function formatDate(
  timestamp: number | string | undefined,
  format: string = 'YYYY-MM-DD',
): string {
  if (!timestamp) return '未知';

  const date = new Date(Number(timestamp) * 1000);
  if (isNaN(date.getTime())) return '未知';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
}

/**
 * 格式化秒数为时长字符串 (mm:ss)
 */
export function formatDuration(seconds: number | undefined): string {
  if (!seconds) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * 格式化播放次数
 */
export function formatPlayCount(count: number | undefined): string {
  if (!count) return '0';
  if (count >= 100000000) {
    return (count / 100000000).toFixed(1) + '亿';
  }
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + '万';
  }
  return count.toString();
}
