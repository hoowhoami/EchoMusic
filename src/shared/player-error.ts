export type PlayerErrorCode =
  | 'cache'
  | 'decode'
  | 'dsp'
  | 'network'
  | 'output-config'
  | 'output-device-unavailable'
  | 'output-exclusive'
  | 'output-runtime'
  | 'output-stream'
  | 'seek';

export interface PlayerErrorPayload {
  message: string;
  errorCode?: PlayerErrorCode;
  reason?: string;
  trackSeq?: number;
  generation?: number;
}
