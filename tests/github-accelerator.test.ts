import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyGithubAcceleratorUrl,
  runGithubAcceleratorFallback,
} from '../src/shared/github-accelerator.ts';

test('rewrites only GitHub-hosted URLs through the configured accelerator', () => {
  assert.equal(
    applyGithubAcceleratorUrl(
      'https://github.com/example/project/archive/main.zip',
      'https://gh.example/',
    ),
    'https://gh.example/https://github.com/example/project/archive/main.zip',
  );
  assert.equal(
    applyGithubAcceleratorUrl('https://example.com/file.zip', 'https://gh.example'),
    'https://example.com/file.zip',
  );
});

test('uses GitHub directly when no accelerator is enabled', async () => {
  const calls: string[] = [];
  const result = await runGithubAcceleratorFallback({
    acceleratorEnabled: false,
    accelerated: async () => {
      calls.push('accelerated');
      return 'accelerated';
    },
    github: async () => {
      calls.push('github');
      return 'github';
    },
  });
  assert.equal(result, 'github');
  assert.deepEqual(calls, ['github']);
});

test('keeps a successful accelerator result without contacting GitHub', async () => {
  const calls: string[] = [];
  const result = await runGithubAcceleratorFallback({
    acceleratorEnabled: true,
    accelerated: async () => {
      calls.push('accelerated');
      return 'accelerated';
    },
    github: async () => {
      calls.push('github');
      return 'github';
    },
  });
  assert.equal(result, 'accelerated');
  assert.deepEqual(calls, ['accelerated']);
});

test('falls back from the accelerator to GitHub exactly once', async () => {
  const calls: string[] = [];
  const result = await runGithubAcceleratorFallback({
    acceleratorEnabled: true,
    accelerated: async () => {
      calls.push('accelerated');
      throw new Error('accelerator unavailable');
    },
    github: async () => {
      calls.push('github');
      return 'github';
    },
    onAcceleratorFailure: () => calls.push('fallback'),
  });
  assert.equal(result, 'github');
  assert.deepEqual(calls, ['accelerated', 'fallback', 'github']);
});

test('does not fall back when the caller marks the failure as cancellation', async () => {
  const cancelled = new Error('cancelled');
  await assert.rejects(
    runGithubAcceleratorFallback({
      acceleratorEnabled: true,
      accelerated: async () => {
        throw cancelled;
      },
      github: async () => 'github',
      shouldFallback: () => false,
    }),
    cancelled,
  );
});
