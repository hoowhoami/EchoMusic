const padDatePart = (part: number) => String(part).padStart(2, '0');

export const formatBirthdayForInput = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const matched = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (matched) {
    return `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
  }
  if (/^\d{9,13}$/.test(text)) {
    const numeric = Number(text);
    const date = new Date(text.length <= 10 ? numeric * 1000 : numeric);
    if (!Number.isNaN(date.getTime())) {
      return `${date.getUTCFullYear()}-${padDatePart(date.getUTCMonth() + 1)}-${padDatePart(date.getUTCDate())}`;
    }
  }
  return '';
};
