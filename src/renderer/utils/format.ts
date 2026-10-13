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
 * 紧凑文件大小文本（如 `59.3M`）
 *
 * 与音质面板里服务端下发的 `size_text` 保持同一风格：单字母单位、无空格、
 * 非字节档保留一位小数。无法解析时返回空串，由调用方决定占位。
 */
export function formatCompactBytes(value: number | undefined | null): string {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'K', 'M', 'G', 'T'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)}${units[unitIndex]}`;
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
