import { EngineErrorCode, type EngineErrorCodeValue } from "../types";
import type { WorkerCommand, WorkerEvent } from "../worker/types";

export interface WorkerClientCallbacks {
	onInitDone: (payload: {
		duration: number;
		metadata: Record<string, string>;
		coverBytes: ArrayBuffer | null;
		coverMime: string | null;
	}) => void;
	onEnded: () => void;
	onError: (code: EngineErrorCodeValue, message: string) => void;
}

export class DecoderWorkerClient {
	private worker: Worker | null = null;

	constructor(
		private workerUrl: string,
		private callbacks: WorkerClientCallbacks,
	) {}

	public init(
		file: File,
		sampleRate: number,
		channels: number,
		sharedBuffer: SharedArrayBuffer,
		ffmpegWasmUrl: string,
	): void {
		if (!this.worker) {
			this.worker = new Worker(this.workerUrl, { type: "module" });

			this.worker.onmessage = (e: MessageEvent<WorkerEvent>) => {
				this.handleMessage(e);
			};

			this.worker.onerror = (e) => {
				this.callbacks.onError(
					EngineErrorCode.SrcNotSupported,
					`Worker error: ${e.message}`,
				);
			};
		}

		this.postCommand({
			type: "INIT",
			payload: { file, sampleRate, channels, sharedBuffer, ffmpegWasmUrl },
		});
	}

	public play(): void {
		this.postCommand({ type: "PLAY" });
	}

	public pause(): void {
		this.postCommand({ type: "PAUSE" });
	}

	public seek(targetSeconds: number): void {
		this.postCommand({
			type: "SEEK",
			payload: { targetSeconds },
		});
	}

	public destroy(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
	}

	private handleMessage(e: MessageEvent<WorkerEvent>): void {
		const data = e.data;

		switch (data.type) {
			case "INIT_DONE":
				this.callbacks.onInitDone(data.payload);
				break;
			case "DECODE_EOF":
				this.callbacks.onEnded();
				break;
			case "DECODE_ERROR":
				this.callbacks.onError(EngineErrorCode.Decode, data.error);
				break;
			case "INIT_ERROR":
				this.callbacks.onError(EngineErrorCode.SrcNotSupported, data.error);
				break;
		}
	}

	/**
	 * Private helper to enforce typing on outgoing messages to the Decoder Worker
	 */
	private postCommand(cmd: WorkerCommand): void {
		this.worker?.postMessage(cmd);
	}
}
