/**
 * Queue memory allocation and buffer watermark configuration (based on seconds)
 */
export interface QueueConfig {
	/** Total capacity of the circular buffer (seconds) */
	capacitySeconds: number;
	/** Notification watermark to trigger decoder wakeup (seconds) */
	notifyWatermarkSeconds: number;
	/** Emergency watermark; decoder wakes up immediately and unconditionally if below this value (seconds) */
	emergencyWatermarkSeconds: number;
}

/**
 * Configuration required to initialize the audio engine.
 */
export interface EngineConfig {
	/**
	 * The AudioContext injected by the host environment.
	 */
	audioContext: AudioContext;

	/**
	 * Injected GainNode for volume control
	 */
	gainNode?: GainNode;

	/**
	 * URLs for external static resources, typically resolved by the host's build tool.
	 */
	assets: {
		workerUrl: string;
		workletUrl: string;
		ffmpegWasmUrl: string;
		soundtouchWasmUrl: string;
	};

	queueConfig?: Partial<QueueConfig>;
}

/**
 * Represents the current playback state of the engine.
 */
export type EngineState = "idle" | "loading" | "ready" | "playing" | "paused";

export const EngineErrorCode = {
	Aborted: 1,
	Network: 2,
	Decode: 3,
	SrcNotSupported: 4,
} as const;

export type EngineErrorCodeValue =
	(typeof EngineErrorCode)[keyof typeof EngineErrorCode];

/**
 * Structure for engine-level errors.
 *
 * The error codes are aligned with the HTML5 MediaError standard
 *
 * [MDN Reference](https://developer.mozilla.org/docs/Web/API/MediaError)
 */
export interface EngineError {
	code: EngineErrorCodeValue;
	message: string;
}

/**
 * Structure for extracted cover art data.
 */
export interface PlayerCover {
	bytes: ArrayBuffer;
	mime: string | null;
}

/**
 * Event map matching the DOM CustomEvent style.
 */
export interface EngineEventMap {
	play: CustomEvent<void>;
	pause: CustomEvent<void>;
	loadedmetadata: CustomEvent<void>;
	timeupdate: CustomEvent<void>;
	ended: CustomEvent<void>;
	error: CustomEvent<EngineError>;
}
