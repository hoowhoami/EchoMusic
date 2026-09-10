import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatAccountAge,
  formatListeningDuration,
  getGradeProgress,
} from '../src/shared/profileStats.ts';

const localSeconds = (year: number, month: number, day: number) =>
  new Date(year, month - 1, day).getTime() / 1000;

test('account age preserves years, calendar months and remaining days', () => {
  assert.equal(
    formatAccountAge(localSeconds(2024, 5, 29), new Date(2026, 8, 10)),
    '2 年 3 个月 12 天',
  );
  assert.equal(formatAccountAge(localSeconds(2026, 1, 31), new Date(2026, 1, 28)), '1 个月');
  assert.equal(formatAccountAge(localSeconds(2024, 2, 29), new Date(2025, 1, 28)), '1 年');
  assert.equal(formatAccountAge(localSeconds(2026, 1, 31), new Date(2026, 2, 1)), '1 个月 1 天');
  assert.equal(formatAccountAge(localSeconds(2026, 9, 10), new Date(2026, 8, 10, 12)), '不足 1 天');
  assert.equal(formatAccountAge(localSeconds(2027, 1, 1), new Date(2026, 8, 10)), '未知');
  assert.equal(formatAccountAge('invalid'), '未知');
  assert.equal(formatAccountAge(0), '未知');
});

test('listening duration uses seconds and falls back to profile minutes', () => {
  assert.equal(formatListeningDuration(90060), '1 天 1 小时 1 分钟');
  assert.equal(formatListeningDuration(3600), '1 小时');
  assert.equal(formatListeningDuration(60), '1 分钟');
  assert.equal(formatListeningDuration(59), '59 秒');
  assert.equal(formatListeningDuration(undefined, 61), '1 小时 1 分钟');
  assert.equal(formatListeningDuration(0, 61), '0 秒');
  assert.equal(formatListeningDuration(-1, '60'), '1 小时');
  assert.equal(formatListeningDuration(NaN, -1), '0 秒');
});

test('grade progress follows cumulative experience, matching the mobile example', () => {
  const progress = getGradeProgress({
    p_grade: 4,
    p_current_point: 10019,
    p_grade_point: 6000,
    p_next_grade: 5,
    p_next_grade_point: 12000,
  });
  assert.equal(progress.available, true);
  assert.equal(progress.remaining, 1981);
  assert.equal(progress.percent, (10019 / 12000) * 100);
});

test('missing thresholds do not fabricate progress and pending upgrades clamp at 100%', () => {
  assert.equal(getGradeProgress({}).available, false);
  assert.equal(
    getGradeProgress({ p_grade: 4, p_current_point: 10, p_next_grade: 5, p_next_grade_point: 0 })
      .available,
    false,
  );
  const progress = getGradeProgress({
    p_grade: '4',
    p_current_point: '12001',
    p_next_grade: '5',
    p_next_grade_point: '12000',
  });
  assert.equal(progress.percent, 100);
  assert.equal(progress.remaining, 0);
});
