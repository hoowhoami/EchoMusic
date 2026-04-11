export type UnknownRecord = Record<string, unknown>;

export const EMPTY_RECORD: UnknownRecord = {};

export const isRecord = (value: unknown): value is UnknownRecord => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

export const toRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : EMPTY_RECORD);
