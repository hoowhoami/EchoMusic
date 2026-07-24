export interface PlayerAudioGraphFormat {
  sampleRate: number;
  channels: number;
  sampleFormat: string;
}

export interface PlayerAudioGraphNodeParameter {
  name: string;
  value: string;
  unit?: string;
  min?: number;
  max?: number;
  runtimeEditable: boolean;
}

export interface PlayerAudioGraphNode {
  kind: string;
  channelRequirement: string;
  flushMode: string;
  reinitOnFormatChange: boolean;
  latencySecs: number;
  runtimeEditable: boolean;
  parameters: PlayerAudioGraphNodeParameter[];
}

export interface PlayerAudioGraphDeviceOutput {
  backend: string;
  format: PlayerAudioGraphFormat;
  bufferSecs: number;
  delaySecs: number;
  underruns: number;
}

export interface PlayerAudioGraphSnapshot {
  revision: number;
  processFormat: PlayerAudioGraphFormat;
  outputFormat: PlayerAudioGraphFormat;
  deviceOutput?: PlayerAudioGraphDeviceOutput;
  latencySecs: number;
  nodes: PlayerAudioGraphNode[];
}

export interface PlayerAudioGraphParameterPatch {
  kind: string;
  name: string;
  value: number;
}

export interface PlayerAudioGraphNodePlanPatch {
  kind: string;
  enabled?: boolean;
}

export interface PlayerAudioGraphPlanPatch {
  nodes?: PlayerAudioGraphNodePlanPatch[];
  patches: PlayerAudioGraphParameterPatch[];
}
