import { app } from 'electron';
import log from './logger';

const MEMORY_DIAGNOSTICS_ENV = 'ECHOMUSIC_MEMORY_DIAGNOSTICS';

const isEnabled = () => {
  const value = String(process.env[MEMORY_DIAGNOSTICS_ENV] ?? '')
    .trim()
    .toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};

const toMb = (kb: number | undefined) =>
  typeof kb === 'number' && Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : null;

export const logMainMemory = async (label: string) => {
  if (!isEnabled()) return;

  try {
    const self = await process.getProcessMemoryInfo();
    const metrics = app
      .getAppMetrics()
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        name: metric.name || metric.serviceName || '',
        workingSetMb: toMb(metric.memory.workingSetSize),
        peakWorkingSetMb: toMb(metric.memory.peakWorkingSetSize),
        privateMb: toMb(metric.memory.privateBytes),
      }))
      .sort((left, right) => (right.workingSetMb ?? 0) - (left.workingSetMb ?? 0));

    log.info('[MemoryDiagnostics]', {
      label,
      self: {
        privateMb: toMb(self.private),
        sharedMb: toMb(self.shared),
        residentSetMb: toMb(self.residentSet),
      },
      processes: metrics,
    });
  } catch (error) {
    log.warn('[MemoryDiagnostics] Failed to sample memory', { label, error });
  }
};
