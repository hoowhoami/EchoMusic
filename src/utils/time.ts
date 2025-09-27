import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import localizedFormat from 'dayjs/plugin/localizedFormat';

dayjs.extend(duration);
dayjs.extend(relativeTime);
dayjs.extend(localizedFormat);

// 秒转为时间
export const secondsToTime = (seconds: number) => {
  if (seconds < 3600) {
    return dayjs.duration(seconds, 'seconds').format('m:ss');
  } else {
    return dayjs.duration(seconds, 'seconds').format('H:mm:ss');
  }
};

// 毫秒转为时间
export const msToTime = (milliseconds: number) => {
  const dur = dayjs.duration(milliseconds, 'milliseconds');
  return milliseconds < 3600000 ? dur.format('mm:ss') : dur.format('H:mm:ss');
};

// 毫秒转为秒
export const msToS = (milliseconds: number, decimalPlaces: number = 2): number => {
  return Number((milliseconds / 1000).toFixed(decimalPlaces));
};

/**
 * 格式化时间戳
 * @param {number|undefined} timestamp - 要格式化的时间戳（以毫秒为单位）。如果为 `null` 或 `0`，则返回空字符串。
 * @param {string} [format="YYYY-MM-DD"] - 可选的时间格式，默认格式为 "YYYY-MM-DD"。可传入任意 dayjs 支持的格式。
 * @returns {string} - 根据指定格式返回的日期字符串
 */
export const formatTimestampSimple = (
  timestamp: number | undefined,
  format: string = 'YYYY-MM-DD',
): string => {
  if (!timestamp) return '';
  const date = dayjs(timestamp);
  const currentYear = dayjs().year();
  const year = date.year();
  // 如果年份相同
  if (year === currentYear) {
    return date.format(format.replace('YYYY-', ''));
  }
  return date.format(format);
};

export const formatTimestamp = (timestamp: number, format: string = 'YYYY-MM-DD'): string => {
  if (!timestamp) return '';
  return dayjs(timestamp).format(format);
};

// 格式化评论时间戳
export const formatCommentTime = (timestamp: number): string => {
  const now = dayjs();
  const diff = now.diff(dayjs(timestamp), 'minute');
  if (diff < 1) {
    return '刚刚发布';
  } else if (diff < 60) {
    return `${diff}分钟前`;
  } else if (diff < 1440) {
    // 1天 = 24小时 * 60分钟
    return `${Math.floor(diff / 60)}小时前`;
  } else if (diff < 525600) {
    // 1年约等于 525600分钟
    return dayjs(timestamp).format('MM-DD HH:mm');
  } else {
    return dayjs(timestamp).format('YYYY-MM-DD HH:mm');
  }
};

/**
 * 计算进度条移动的距离
 * @param {number} currentTime
 * @param {number} duration
 * @returns {number} 进度条移动的距离，精确到 0.01，最大为 100
 */
export const calculateProgress = (currentTime: number, duration: number): number => {
  if (duration === 0) return 0;

  const progress = (currentTime / duration) * 100;
  return Math.min(Math.round(progress * 100) / 100, 100);
};

/**
 * 根据进度和总时长反推当前时间
 * @param {number} progress 进度百分比，范围通常是0到100
 * @param {number} duration 总时长，单位为秒
 * @returns {number} 当前时间，单位为秒，精确到0.01秒
 */
export const calculateCurrentTime = (progress: number, duration: number): number => {
  // 确保在有效范围内
  progress = Math.min(Math.max(progress, 0), 100);

  const currentTime = (progress / 100) * duration;
  return Math.round(currentTime * 100) / 100;
};

/**
 * 获取当前时间段的问候语
 */
export const getGreeting = () => {
  const hour = dayjs().hour();
  if (hour < 6) {
    return '凌晨好';
  } else if (hour < 9) {
    return '早上好';
  } else if (hour < 12) {
    return '上午好';
  } else if (hour < 14) {
    return '中午好';
  } else if (hour < 17) {
    return '下午好';
  } else if (hour < 19) {
    return '傍晚好';
  } else if (hour < 22) {
    return '晚上好';
  } else {
    return '夜深了';
  }
};

/**
 * 是否为当天的6点之前
 * @param timestamp 当前时间戳
 */
export const isBeforeSixAM = (timestamp: number) => {
  // 当天的早上 6 点
  const sixAM = dayjs().startOf('day').add(6, 'hour');
  // 判断输入时间是否在六点之前
  const inputTime = dayjs(timestamp);
  return inputTime.isBefore(sixAM);
};

/**
 * 将 ISO 8601 格式的时间字符串转换为本地时间
 * @param isoString - ISO 8601 格式的时间字符串
 * @returns
 */
export const convertToLocalTime = (isoString: string): string => {
  return dayjs(isoString).format('YYYY-MM-DD HH:mm:ss');
};

export const isYesterday = (timestamp: number) => {
  // 处理秒级时间戳（10位），转换为毫秒级（13位）
  const adjustedTimestamp = timestamp.toString().length === 10 ? timestamp * 1000 : timestamp;

  // 转换目标时间戳为「年-月-日」
  const targetDate = dayjs(adjustedTimestamp).format('YYYY-MM-DD');
  // 获取昨天的「年-月-日」
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

  return targetDate === yesterday;
};

export const isBeforeToday = (timestamp: number) => {
  // 处理秒级时间戳（10位）转毫秒级（13位）
  const adjustedTimestamp = timestamp.toString().length === 10 ? timestamp * 1000 : timestamp;

  // 目标日期的「年-月-日」
  const targetDate = dayjs(adjustedTimestamp).format('YYYY-MM-DD');
  // 今天的「年-月-日」
  const today = dayjs().format('YYYY-MM-DD');

  // 比较目标日期是否早于今天
  return dayjs(targetDate).isBefore(today);
};

export const isAfterToday = (timestamp: number) => {
  // 处理秒级时间戳（10位）转换为毫秒级（13位）
  const adjustedTimestamp = timestamp.toString().length === 10 ? timestamp * 1000 : timestamp;

  // 提取目标日期的「年-月-日」（忽略具体时间）
  const targetDate = dayjs(adjustedTimestamp).format('YYYY-MM-DD');
  // 提取今天的「年-月-日」
  const today = dayjs().format('YYYY-MM-DD');

  // 比较目标日期是否晚于今天
  return dayjs(targetDate).isAfter(today);
};

export const isToday = (timestamp: number) => {
  // 处理秒级时间戳（10位）转换为毫秒级（13位）
  const adjustedTimestamp = timestamp.toString().length === 10 ? timestamp * 1000 : timestamp;

  // 提取目标日期的「年-月-日」（忽略具体时间）
  const targetDate = dayjs(adjustedTimestamp).format('YYYY-MM-DD');
  // 提取今天的「年-月-日」
  const today = dayjs().format('YYYY-MM-DD');

  // 比较目标日期是否是今天
  return dayjs(targetDate).isSame(today);
};

export const formatTimeDiff = (timestamp: number) => {
  // 转换时间戳为 dayjs 对象
  const targetTime = dayjs(timestamp);
  const now = dayjs();

  // 计算时间差（毫秒），取绝对值（支持过去和未来的时间）
  const diffMs = Math.abs(now.diff(targetTime));

  // 用 duration 解析时间差
  const diff = dayjs.duration(diffMs);

  // 提取年、月、天（注：dayjs 的月和年是近似值，基于30天/月和365天/年）
  const years = Math.floor(diff.years());
  const months = Math.floor(diff.months());
  const days = Math.floor(diff.days() % 30); // 扣除月份包含的天后的剩余天数

  // 拼接结果（只保留有值的部分）
  const parts = [];
  if (years > 0) parts.push(`${years}年`);
  if (months > 0) parts.push(`${months}个月`);
  if (days > 0) parts.push(`${days}天`);

  // 若所有值为0，返回"0天"
  return parts.length > 0 ? parts.join('') : '0天';
};

export const formatMinutesToHM = (minutes: number) => {
  // 处理非数字或负数（默认按0处理）
  if (typeof minutes !== 'number' || minutes < 0) {
    minutes = 0;
  }

  // 转换为分钟数（取整，避免小数干扰）
  const totalMinutes = Math.floor(minutes);

  // 用 duration 解析总分钟数（单位：分钟）
  const duration = dayjs.duration(totalMinutes, 'minutes');

  // 提取小时和剩余分钟
  const hours = Math.floor(duration.asHours()); // 总小时数（向下取整）
  const mins = duration.minutes(); // 剩余分钟（0-59）

  // 拼接结果（处理0小时或0分钟的情况）
  const parts = [];
  if (hours > 0) parts.push(`${hours}小时`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}分钟`); // 若没有小时，强制显示分钟

  return parts.join('');
};

// 日期字符串转换函数
export const convertDateFormat = (inputDate: string, inputFormat: string, outputFormat: string) => {
  // 解析输入日期（如果知道输入格式，建议指定以提高准确性）
  const date = inputFormat ? dayjs(inputDate, inputFormat) : dayjs(inputDate);

  // 检查日期是否有效
  if (!date.isValid()) {
    throw new Error('无效的日期格式');
  }

  // 转换为目标格式并返回
  return date.format(outputFormat);
};
