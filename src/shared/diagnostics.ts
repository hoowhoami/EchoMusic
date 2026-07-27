export type DiagnosticsMemoryBlock = {
  workingSetMb?: number | null;
  peakWorkingSetMb?: number | null;
  privateMb?: number | null;
  sharedMb?: number | null;
  residentSetMb?: number | null;
};

export type DiagnosticsAppProcessMetric = DiagnosticsMemoryBlock & {
  pid: number;
  type: string;
  name: string;
};

export type DiagnosticsPerformanceMemory = {
  usedJsHeapMb: number | null;
  totalJsHeapMb: number | null;
  jsHeapLimitMb: number | null;
};

export type DiagnosticsNodeMemory = {
  rssMb: number | null;
  heapTotalMb: number | null;
  heapUsedMb: number | null;
  externalMb: number | null;
  arrayBuffersMb: number | null;
};

export type DiagnosticsResourceUsageEntry = {
  count?: number | null;
  sizeMb?: number | null;
  liveSizeMb?: number | null;
};

export type DiagnosticsResourceUsage = Record<string, DiagnosticsResourceUsageEntry>;

export type DiagnosticsMemorySnapshot = {
  capturedAt: number;
  label?: string;
  rendererPid: number;
  renderer: DiagnosticsMemoryBlock | null;
  rendererNode: DiagnosticsNodeMemory | null;
  performance: DiagnosticsPerformanceMemory | null;
  resources: DiagnosticsResourceUsage | null;
  appProcesses: DiagnosticsAppProcessMetric[];
};
