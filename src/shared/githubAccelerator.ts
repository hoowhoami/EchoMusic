export const normalizeGithubAcceleratorUrl = (value?: string): string =>
  String(value ?? '')
    .trim()
    .replace(/\/+$/, '');

export const isGithubHostedUrl = (value: string): boolean => {
  try {
    const { hostname } = new URL(value);
    return (
      hostname === 'github.com' ||
      hostname === 'raw.githubusercontent.com' ||
      hostname === 'codeload.github.com' ||
      hostname.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
};

export const applyGithubAcceleratorUrl = (url: string, acceleratorUrl?: string): string => {
  const target = String(url ?? '').trim();
  const accelerator = normalizeGithubAcceleratorUrl(acceleratorUrl);
  if (!target || !accelerator || !/^https?:\/\//i.test(target) || !isGithubHostedUrl(target)) {
    return target;
  }
  return `${accelerator}/${target}`;
};

interface GithubAcceleratorFallbackOptions<T> {
  acceleratorEnabled: boolean;
  accelerated: () => Promise<T>;
  github: () => Promise<T>;
  onAcceleratorFailure?: (error: unknown) => void;
  shouldFallback?: (error: unknown) => boolean;
}

export const runGithubAcceleratorFallback = async <T>({
  acceleratorEnabled,
  accelerated,
  github,
  onAcceleratorFailure,
  shouldFallback = () => true,
}: GithubAcceleratorFallbackOptions<T>): Promise<T> => {
  if (!acceleratorEnabled) return github();
  try {
    return await accelerated();
  } catch (error) {
    if (!shouldFallback(error)) throw error;
    onAcceleratorFailure?.(error);
    return github();
  }
};
