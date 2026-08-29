import type { StretchAlgorithm } from "../../types";

export type WorkletCommand =
	| {
			type: "INIT";
			payload: {
				sharedBuffer: SharedArrayBuffer;
				channels: number;
				wasmBytes: ArrayBuffer;
				initId: number;
				tempo: number;
				pitch: number;
				rate: number;
				algorithm?: StretchAlgorithm;
			};
	  }
	| { type: "SET_TEMPO"; payload: { tempo: number } }
	| { type: "SET_PITCH"; payload: { pitch: number } }
	| { type: "SET_RATE"; payload: { rate: number } }
	| { type: "SET_ALGORITHM"; payload: { algorithm: StretchAlgorithm } }
	| {
			type: "SET_FORMANT";
			payload: { factor: number; compensatePitch: boolean };
	  }
	| { type: "DESTROY" };

export type WorkletEvent =
	| { type: "INIT_DONE"; payload: { initId: number } }
	| { type: "INIT_ERROR"; payload: { initId: number; message: string } }
	| { type: "AUTO_PAUSED" };
