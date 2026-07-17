export type WorkerCommand =
	| {
			type: "INIT";
			payload: {
				file: File;
				sampleRate: number;
				channels: number;
				sharedBuffer: SharedArrayBuffer;
				ffmpegWasmUrl: string;
			};
	  }
	| { type: "PLAY" }
	| { type: "PAUSE" }
	| { type: "SEEK"; payload: { targetSeconds: number } };

export type WorkerEvent =
	| {
			type: "INIT_DONE";
			payload: {
				duration: number;
				metadata: Record<string, string>;
				coverBytes: ArrayBuffer | null;
				coverMime: string | null;
			};
	  }
	| { type: "DECODE_EOF" }
	| { type: "DECODE_ERROR"; error: string }
	| { type: "INIT_ERROR"; error: string };
