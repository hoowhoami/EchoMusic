export const preferenceFields = ['mode', 'song_lang', 'gender', 'age', 'lang', 'style'] as const;
export type PreferenceField = (typeof preferenceFields)[number];
export type PreferenceValues = Record<PreferenceField, string>;
export type PreferencePatch = Partial<PreferenceValues>;
export interface PreferenceOption {
  value: string;
  label: string;
}

// 酷狗官方 H5 settings/v-3e4978eb（2026-09-11），与基础 lang/style 数字 ID 独立。
export const recommendationModes = [
  { value: '1', label: '熟悉模式', description: '多听熟悉的音乐' },
  { value: '0', label: '默认模式', description: '在熟悉与新鲜之间平衡' },
  { value: '2', label: '尝鲜模式', description: '发现更多新鲜音乐' },
];
export const recommendationOptions: PreferenceOption[] = [
  { value: 'L1', label: '国语' },
  { value: 'L2', label: '英语' },
  { value: 'L5', label: '粤语' },
  { value: 'L4', label: '韩语' },
  { value: 'L3', label: '日语' },
  { value: 'L6', label: '纯音乐' },
  { value: 'S9', label: 'DJ' },
  { value: 'T1', label: '翻唱' },
  { value: 'N2', label: '现场' },
  { value: 'S28', label: 'AI 歌曲' },
];

const options = (entries: [string, string][]): PreferenceOption[] =>
  entries.map(([value, label]) => ({ value, label }));

// KuGouMusicApi/docs/README.md: 标准版安卓偏好标签。与个人资料性别编码不同。
export const preferenceGroups = [
  {
    field: 'lang',
    title: '喜欢的语言',
    description: '选择你想多听的语言，可多选。',
    options: options([
      ['1', '国语'],
      ['2', '粤语'],
      ['4', '英语'],
      ['5', '日语'],
      ['6', '韩语'],
      ['19', '闽南语'],
      ['7', '德语'],
      ['8', '法语'],
      ['9', '意大利语'],
      ['11', '葡萄牙语'],
      ['13', '俄语'],
      ['20', '藏语'],
      ['21', '泰语'],
      ['22', '越南语'],
      ['18', '小语种'],
    ]),
  },
  {
    field: 'style',
    title: '喜欢的风格',
    description: '从熟悉的旋律，到新的心动，可多选。',
    options: options([
      ['1', '流行'],
      ['2', '摇滚'],
      ['3', '电子'],
      ['10', '民谣'],
      ['6', '嘻哈'],
      ['14', 'R&B'],
      ['21', '国风'],
      ['9', '纯音乐'],
      ['4', '古典乐'],
      ['7', '爵士'],
      ['5', '舞曲'],
      ['12', '乡村'],
      ['15', 'DJ'],
      ['16', 'ACG'],
      ['23', '传统民歌'],
    ]),
  },
] as const;
export const preferenceGenderOptions = options([
  ['', '不设置'],
  ['1', '女'],
  ['2', '男'],
]);
export const preferenceAgeOptions = options([
  ['', '不设置'],
  ['6', '10后'],
  ['7', '05后'],
  ['1', '00后'],
  ['8', '95后'],
  ['2', '90后'],
  ['9', '85后'],
  ['3', '80后'],
  ['10', '75后'],
  ['4', '70后'],
  ['11', '65后'],
  ['12', '60后'],
  ['0', '其它'],
]);

export function emptyPreferences(): PreferenceValues {
  return { mode: '', song_lang: '', gender: '', age: '', lang: '', style: '' };
}

export function ensurePreferenceSuccess(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('偏好设置响应无效，请重试');
  }
  const body = payload as Record<string, unknown>;
  if (Number(body.status) !== 1 || Number(body.error_code ?? body.errcode ?? 0) !== 0) {
    throw new Error(String(body.errmsg || body.msg || '偏好设置请求失败，请稍后重试'));
  }
  return body;
}

export function parsePreferences(payload: unknown): PreferenceValues {
  const body = ensurePreferenceSuccess(payload);
  if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
    throw new Error('未能读取偏好设置，请重试');
  }
  const data = body.data as Record<string, unknown>;
  const result = emptyPreferences();
  for (const field of preferenceFields) {
    const value = data[field];
    result[field] =
      value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return result;
}

/** null 表示无法安全编辑，不能把损坏的数据当作空选择覆盖。 */
export function preferenceWeights(value: string): Record<string, number> | null {
  if (!value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (
      !Object.entries(parsed).every(
        ([id, weight]) =>
          /^[A-Za-z]?\d+$/.test(id) && typeof weight === 'number' && Number.isFinite(weight),
      )
    )
      return null;
    return parsed as Record<string, number>;
  } catch {
    return null;
  }
}

export function togglePreference(value: string, id: string): string {
  const weights = preferenceWeights(value);
  if (!weights) return value;
  if ((weights[id] ?? 0) > 50) delete weights[id];
  else weights[id] = 100;
  return Object.keys(weights).length ? JSON.stringify(weights) : '';
}

export function preferenceEqual(field: PreferenceField, left: string, right: string): boolean {
  if (left === right) return true;
  if (field === 'mode') return (left || '0') === (right || '0');
  if (field === 'gender' || field === 'age') return false;
  const a = preferenceWeights(left),
    b = preferenceWeights(right);
  if (field === 'song_lang' && a && b) {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
      (id) => (a[id] ?? 50) === (b[id] ?? 50),
    );
  }
  return Boolean(
    a &&
    b &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([id, weight]) => b[id] === weight),
  );
}

export function preferenceChanges(
  before: PreferenceValues,
  after: PreferenceValues,
): PreferencePatch {
  return Object.fromEntries(
    preferenceFields
      .filter((field) => !preferenceEqual(field, before[field], after[field]))
      .map((field) => [field, after[field]]),
  );
}

export function preferenceError(error: unknown, fallback: string): string {
  const response = (error as { response?: { body?: Record<string, unknown> } } | null)?.response;
  const message = response?.body?.errmsg || response?.body?.msg;
  if (typeof message === 'string' && message.trim()) return message;
  return error instanceof Error && !error.message.startsWith('API Error:')
    ? error.message
    : fallback;
}

export function recommendationStrength(value: string, id: string): number {
  return Math.min(100, Math.max(0, preferenceWeights(value)?.[id] ?? 50));
}

export function setRecommendationStrength(value: string, id: string, strength: number): string {
  const weights = preferenceWeights(value);
  if (
    !weights ||
    !recommendationOptions.some((option) => option.value === id) ||
    !Number.isFinite(strength)
  )
    return value;
  const normalized = Math.round(Math.min(100, Math.max(0, strength)));
  // 缺省强度为50；显式保留50便于与远端已保存值确认同步。
  weights[id] = normalized;
  return JSON.stringify(weights);
}

export function resetRecommendationPreferences(value: PreferenceValues): PreferenceValues {
  let songLang = value.song_lang;
  for (const option of recommendationOptions)
    songLang = setRecommendationStrength(songLang, option.value, 50);
  return { ...value, mode: '0', song_lang: songLang };
}

export function recommendationValidation(value: PreferenceValues): string {
  const weights = preferenceWeights(value.song_lang);
  if (!weights) return '';
  if (['L1', 'L2', 'L5', 'L4', 'L3', 'L6'].every((id) => weights[id] === 0))
    return '语种不能全部屏蔽，请至少保留一种。';
  if ((weights.S9 ?? 50) > 50 && weights.T1 === 0)
    return '加大 DJ 推荐强度时，请保留翻唱推荐；许多 DJ 歌曲属于翻唱。';
  return '';
}

export function strengthLabel(value: number): string {
  return value === 0 ? '已屏蔽' : value === 50 ? '默认强度' : value < 50 ? '减少推荐' : '加大推荐';
}
