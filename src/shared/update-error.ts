const DEFAULT_UPDATE_CHECK_ERROR = '更新检查失败，请稍后重试。';
const UPDATE_METADATA_PUBLISHING_ERROR = '新版本正在发布，更新文件尚未准备完成，请稍后重试。';

const readErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'string') return error.trim();
  if (error && typeof error === 'object') {
    const message = Reflect.get(error, 'message');
    if (typeof message === 'string') return message.trim();
  }
  return '';
};

export const isUpdateMetadataPublishingError = (error: unknown): boolean => {
  const message = readErrorMessage(error);
  if (!/latest(?:-[\w-]+)?\.ya?ml/i.test(message)) return false;
  return /cannot find .*release artifacts|http(?:error)?[^\n]*404|\b404\b/i.test(message);
};

export const formatUpdateCheckError = (error: unknown): string => {
  if (isUpdateMetadataPublishingError(error)) return UPDATE_METADATA_PUBLISHING_ERROR;
  return readErrorMessage(error) || DEFAULT_UPDATE_CHECK_ERROR;
};
