import type {
  DspJsonValue,
  DspProviderControl,
  DspProviderManifest,
  DspProviderRuntimeState,
} from './player-audio-graph';

export type DspControlValues = Record<string, { value: DspJsonValue }>;
export type DspPresetBank = Record<string, string>;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseDspPreset(json: string): { presetId: string; controls: DspControlValues } {
  try {
    const value: unknown = JSON.parse(json);
    if (!record(value) || typeof value.presetId !== 'string') return { presetId: '', controls: {} };
    const controls: DspControlValues = {};
    if (record(value.controls)) {
      for (const [id, entry] of Object.entries(value.controls)) {
        if (record(entry) && Object.hasOwn(entry, 'value')) {
          Object.defineProperty(controls, id, { value: { value: entry.value }, enumerable: true });
        }
      }
    }
    return { presetId: value.presetId, controls };
  } catch {
    return { presetId: '', controls: {} };
  }
}

export function dspPresetBankKey(engineId: string, mode: string, presetId: string): string {
  return JSON.stringify([engineId, mode, presetId]);
}

// Editing a preset is not selecting it: only the active preset can update playback.
export function dspPresetSettingsPatch(
  state: {
    dspProviderPresetJson: string;
    dspProviderPresetBank: DspPresetBank;
    dspProviderMode: string;
    impulseResponseEnabled: boolean;
  },
  engineId: string,
  presetJson: string,
): { dspProviderPresetBank?: DspPresetBank; dspProviderPresetJson?: string } {
  const json = presetJson.trim();
  const { presetId } = parseDspPreset(json);
  if (!engineId || !presetId) return {};
  return {
    dspProviderPresetBank: {
      ...state.dspProviderPresetBank,
      [dspPresetBankKey(engineId, state.dspProviderMode, presetId)]: json,
    },
    ...(!state.impulseResponseEnabled &&
    parseDspPreset(state.dspProviderPresetJson).presetId === presetId
      ? { dspProviderPresetJson: json }
      : {}),
  };
}

export function presetControls(
  manifest: DspProviderManifest | null,
  presetId: string,
): DspProviderControl[] {
  if (!presetId) return [];
  const preset = manifest?.presets?.find((item) => item.id === presetId);
  return preset?.controls ?? manifest?.controls ?? [];
}

// Configuration availability is a capability, not an implementation-progress label.
export function configurablePresetControls(
  manifest: DspProviderManifest | null,
  presetId: string,
): DspProviderControl[] {
  return presetControls(manifest, presetId).filter(
    (control) =>
      control.ownership !== 'host' &&
      control.ownership !== 'disabled' &&
      (control.type === 'number' ||
        control.type === 'boolean' ||
        (control.type === 'select' && !!control.options?.length)),
  );
}

export function controlDefault(control: DspProviderControl): DspJsonValue {
  return (
    control.defaultValue ??
    control.value ??
    control.options?.[0]?.value ??
    (control.type === 'boolean'
      ? false
      : control.type === 'number'
        ? (control.range?.min ?? 0)
        : '')
  );
}

export function validControlValue(control: DspProviderControl, value: DspJsonValue): boolean {
  if (control.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const { min = -Infinity, max = Infinity, step } = control.range ?? {};
    if (value < min || value > max) return false;
    if (step && step > 0) {
      const position = (value - (Number.isFinite(min) ? min : 0)) / step;
      if (Math.abs(position - Math.round(position)) > 1e-6) return false;
    }
    return true;
  }
  if (control.type === 'boolean') return typeof value === 'boolean';
  if (control.type === 'select') {
    return (
      control.options?.some((option) => JSON.stringify(option.value) === JSON.stringify(value)) ??
      false
    );
  }
  return control.type === 'string' ? typeof value === 'string' : control.type === 'json';
}

export function presetControlValues(
  controls: DspProviderControl[],
  json: string,
): DspControlValues {
  const saved = parseDspPreset(json).controls;
  return Object.fromEntries(
    controls
      .filter((c) => c.ownership !== 'disabled' && c.ownership !== 'host')
      .map((c) => {
        const value = saved[c.id]?.value;
        return [
          c.id,
          { value: value !== undefined && validControlValue(c, value) ? value : controlDefault(c) },
        ];
      }),
  );
}

// Preserve a preset's identity; never merge values from another preset's runtime state.
export function makeDspPresetJson(
  presetId: string,
  controls: DspProviderControl[],
  saved = '',
): string {
  const values = presetControlValues(
    controls,
    parseDspPreset(saved).presetId === presetId ? saved : '',
  );
  return JSON.stringify(Object.keys(values).length ? { presetId, controls: values } : { presetId });
}

export function runtimeMatchesPreset(
  state: DspProviderRuntimeState | null,
  presetId: string,
): boolean {
  return !!presetId && (state?.presetId ?? state?.effect?.id ?? state?.currentEffect) === presetId;
}

export function controlVisible(control: DspProviderControl, values: DspControlValues): boolean {
  return (
    !control.visibleWhen ||
    JSON.stringify(values[control.visibleWhen.controlId]?.value) ===
      JSON.stringify(control.visibleWhen.value)
  );
}
