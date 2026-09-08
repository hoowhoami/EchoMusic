import { logger } from './logger';

// 使用同一 navigation 时间原点；仅记录每阶段第一次到达，避免路由重试重复计时。
export const markStartup = (stage: string) => {
  const name = `echo:${stage}`;
  if (performance.getEntriesByName(name).length) return;
  performance.mark(name);
  const stages = performance
    .getEntriesByType('mark')
    .filter((entry) => entry.name.startsWith('echo:'));
  const navigation = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  logger.info('Startup', stage, {
    ...Object.fromEntries(
      stages.map((entry) => [`${entry.name.slice(5)}Ms`, Math.round(entry.startTime * 10) / 10]),
    ),
    documentResponseStartMs: navigation ? Math.round(navigation.responseStart) : undefined,
    documentResponseEndMs: navigation ? Math.round(navigation.responseEnd) : undefined,
  });
};

// Reveal the initial Vue route once mounted, or expose startup errors immediately.
export const finishStartup = () => {
  document.getElementById('startup-placeholder')?.remove();
  document.documentElement.removeAttribute('data-echo-starting');
};

export const updateStartupStatus = (message: string) => {
  const status = document.querySelector('#startup-placeholder .startup-status');
  if (status) status.textContent = message;
};
