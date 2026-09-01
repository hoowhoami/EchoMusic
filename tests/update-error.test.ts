import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatUpdateCheckError,
  isUpdateMetadataPublishingError,
} from '../src/shared/update-error.ts';

test('recognizes missing updater metadata while a Release is being published', () => {
  const error = new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404');

  assert.equal(isUpdateMetadataPublishingError(error), true);
  assert.equal(formatUpdateCheckError(error), '新版本正在发布，更新文件尚未准备完成，请稍后重试。');
});

test('recognizes platform-specific updater metadata names', () => {
  assert.equal(
    isUpdateMetadataPublishingError(
      'GET https://github.com/example/app/releases/download/v1.0.0/latest-mac.yml: 404',
    ),
    true,
  );
  assert.equal(
    isUpdateMetadataPublishingError(
      'GET https://github.com/example/app/releases/download/v1.0.0/latest-linux-arm64.yml: 404',
    ),
    true,
  );
});

test('preserves unrelated updater errors', () => {
  const message = 'network connection timed out';
  assert.equal(isUpdateMetadataPublishingError(message), false);
  assert.equal(formatUpdateCheckError(new Error(message)), message);
});

test('uses a safe fallback for errors without a message', () => {
  assert.equal(formatUpdateCheckError(null), '更新检查失败，请稍后重试。');
});
