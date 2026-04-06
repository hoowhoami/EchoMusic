export type ApiServerState = 'idle' | 'starting' | 'ready' | 'failed';

export interface ApiServerStatus {
  state: ApiServerState;
  error?: string;
  updatedAt: number;
}
