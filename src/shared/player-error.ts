export type PlayerErrorCode =
  | 'decode'
  | 'output-config'
  | 'output-device-unavailable'
  | 'output-exclusive'
  | 'output-runtime'
  | 'output-stream';

export interface PlayerErrorPayload {
  message: string;
  errorCode?: PlayerErrorCode;
}
