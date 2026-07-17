/* tslint:disable */
/* eslint-disable */

export class SoundTouchProcessor {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    extractOutput(max_samples: number): number;
    getInputChunkSize(): number;
    getInputPtr(channel: number): number;
    getOutputPtr(channel: number): number;
    constructor(channels: number, sample_rate: number);
    numSamples(): number;
    processInput(num_samples: number): void;
    setPitch(pitch: number): void;
    setRate(rate: number): void;
    setTempo(tempo: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_soundtouchprocessor_free: (a: number, b: number) => void;
    readonly soundtouchprocessor_clear: (a: number) => void;
    readonly soundtouchprocessor_extractOutput: (a: number, b: number, c: number) => void;
    readonly soundtouchprocessor_getInputChunkSize: (a: number) => number;
    readonly soundtouchprocessor_getInputPtr: (a: number, b: number) => number;
    readonly soundtouchprocessor_getOutputPtr: (a: number, b: number) => number;
    readonly soundtouchprocessor_new: (a: number, b: number, c: number) => void;
    readonly soundtouchprocessor_numSamples: (a: number) => number;
    readonly soundtouchprocessor_processInput: (a: number, b: number, c: number) => void;
    readonly soundtouchprocessor_setPitch: (a: number, b: number) => void;
    readonly soundtouchprocessor_setRate: (a: number, b: number) => void;
    readonly soundtouchprocessor_setTempo: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
