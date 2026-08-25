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
  bufferMode?: string;
  bufferSecs: number;
  requestedBufferSecs?: number;
  deviceBufferSecs?: number;
  softwareBufferSecs?: number;
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
  providerId?: string;
  providerVersion?: string;
  providerPath?: string;
  providerMode?: 'headphone' | 'speaker';
  providerResourceJson?: string;
  providerPresetJson?: string;
  providerLatencyFrames?: number;
  providerPreferredBlockFrames?: number;
  providerManifestJson?: string;
  providerStateJson?: string;
}

export type DspControlOwnership = 'host' | 'provider' | 'disabled';

export type DspControlPolicy = Record<string, DspControlOwnership>;

export type DspJsonValue =
  | null
  | boolean
  | number
  | string
  | DspJsonValue[]
  | {
      [key: string]: DspJsonValue;
    };

export interface DspProviderControl {
  id: string;
  type: 'number' | 'boolean' | 'string' | 'select' | 'json';
  label?: string;
  value?: DspJsonValue;
  unit?: string;
  range?: { min?: number; max?: number; step?: number };
  options?: Array<{ value: DspJsonValue; label: string }>;
  ownership?: DspControlOwnership;
}

export interface DspProviderManifest {
  schemaVersion: number;
  displayName?: string;
  description?: string;
  vendor?: string;
  controls?: DspProviderControl[];
  presets?: DspProviderPreset[];
  resources?: Array<{ kind: string; extensions?: string[] }>;
}

export interface DspProviderPreset {
  id: string;
  label: string;
  description?: string;
  modules?: string[];
}

export interface DspProviderRuntimeState {
  currentEffect?: string;
  presetId?: string;
  controlPolicy?: DspControlPolicy;
  activeModules?: string[];
  controls?: Record<string, { value?: DspJsonValue; ownership?: DspControlOwnership }>;
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
