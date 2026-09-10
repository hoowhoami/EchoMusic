const nonNegativeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean')
    return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

export function formatListeningDuration(seconds: unknown, minutes?: unknown): string {
  const value = nonNegativeNumber(seconds) ?? (nonNegativeNumber(minutes) ?? 0) * 60;
  const total = Math.floor(value);
  if (total < 60) return `${total} 秒`;
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const remainingMinutes = Math.floor((total % 3600) / 60);
  return [
    days && `${days} 天`,
    hours && `${hours} 小时`,
    remainingMinutes && `${remainingMinutes} 分钟`,
  ]
    .filter(Boolean)
    .join(' ');
}

/** 注册时间为 Unix 秒；按本地日历计算完整月份，月末对齐到目标月最后一天。 */
export function formatAccountAge(timestamp: unknown, now = new Date()): string {
  const seconds = nonNegativeNumber(timestamp);
  if (seconds === null || seconds <= 0 || !Number.isFinite(now.getTime())) return '未知';
  const start = new Date(seconds * 1000);
  if (!Number.isFinite(start.getTime()) || start > now) return '未知';
  // 将本地日期投影到 UTC，避免夏令时导致一天不足 24 小时。
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const anniversary = (months: number) => {
    const first = new Date(Date.UTC(start.getFullYear(), start.getMonth() + months, 1));
    const lastDay = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return Date.UTC(
      first.getUTCFullYear(),
      first.getUTCMonth(),
      Math.min(start.getDate(), lastDay),
    );
  };
  let months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth();
  if (anniversary(months) > today) months -= 1;
  const years = Math.floor(months / 12);
  const days = Math.round((today - anniversary(months)) / 86400000);
  return (
    [years && `${years} 年`, months % 12 && `${months % 12} 个月`, days && `${days} 天`]
      .filter(Boolean)
      .join(' ') || '不足 1 天'
  );
}

export function getGradeProgress(detail: Record<string, unknown>) {
  const grade = nonNegativeNumber(detail.p_grade);
  const current = nonNegativeNumber(detail.p_current_point);
  const nextGrade = nonNegativeNumber(detail.p_next_grade);
  const target = nonNegativeNumber(detail.p_next_grade_point);
  const available =
    grade !== null &&
    current !== null &&
    nextGrade !== null &&
    nextGrade > grade &&
    target !== null &&
    target > 0;
  return {
    grade,
    current,
    nextGrade,
    target,
    available,
    remaining: available ? Math.max(0, target - current) : null,
    percent: available ? Math.min(100, (current / target) * 100) : 0,
  };
}
