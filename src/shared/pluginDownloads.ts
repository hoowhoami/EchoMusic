import type { DownloadTarget, FileRef, PluginResourceError } from './pluginFiles';
export interface DownloadSource {
  url: string;
  headers?: Record<string, string>;
}
export interface DownloadOptions extends DownloadSource {
  target: DownloadTarget;
  name?: string;
  sourceKey?: string;
  idempotencyKey?: string;
  conflict?: 'fail' | 'rename' | 'replace';
  resume?: boolean;
  expectedBytes?: number;
  maxBytes?: number;
  checksum?: { algorithm: 'sha256'; value: string };
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}
export type DownloadState =
  | 'queued'
  | 'connecting'
  | 'downloading'
  | 'paused'
  | 'interrupted'
  | 'verifying'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'canceled';
export interface DownloadResult {
  taskId: string;
  file: FileRef;
  bytes: number;
  sha256?: string;
}
export interface DownloadSnapshot {
  id: string;
  runId: number;
  revision: number;
  state: DownloadState;
  name: string;
  sourceKey?: string;
  target: DownloadTarget;
  receivedBytes: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  remainingSeconds?: number;
  createdAt: number;
  updatedAt: number;
  canPause: boolean;
  canResume: boolean;
  canRetry: boolean;
  error?: PluginResourceError;
  result?: DownloadResult;
}
export interface DownloadHandle {
  readonly id: string;
  getSnapshot(): Promise<DownloadSnapshot>;
  subscribe(callback: (snapshot: DownloadSnapshot) => void): () => void;
  pause(): Promise<DownloadSnapshot>;
  resume(source?: DownloadSource): Promise<DownloadSnapshot>;
  retry(source?: DownloadSource): Promise<DownloadSnapshot>;
  cancel(): Promise<DownloadSnapshot>;
  wait(options?: { signal?: AbortSignal }): Promise<DownloadResult>;
}
