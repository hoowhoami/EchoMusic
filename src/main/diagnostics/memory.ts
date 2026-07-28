import { app } from 'electron';
import log, { isDiagnosticModeActive } from '../logger';
import type { DiagnosticsAppProcessMetric } from '../../shared/diagnostics';

const toMb = (kb: number | undefined) =>
  typeof kb === 'number' && Number.isFinite(kb) ? Math.round((kb / 1024) * 10) / 10 : null;

export const getAppMemoryMetrics = (): DiagnosticsAppProcessMetric[] =>
  app
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

export const logMainMemory = async (label: string) => {
  if (!isDiagnosticModeActive()) return;

  try {
    const self = await process.getProcessMemoryInfo();

    log.info('[MemoryDiagnostics]', {
      label,
      self: {
        privateMb: toMb(self.private),
        sharedMb: toMb(self.shared),
        residentSetMb: toMb(self.residentSet),
      },
      processes: getAppMemoryMetrics(),
    });
  } catch (error) {
    log.warn('[MemoryDiagnostics] Failed to sample memory', { label, error });
  }
};
