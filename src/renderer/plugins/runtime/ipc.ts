export const serializeForIpc = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};
