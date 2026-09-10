import { type AudioWriter, createAudioWriter } from "../queue";
import { getErrorMessage } from "../utils";
import type { FFmpegAudioModule, WorkerCommand, WorkerEvent } from "./types";
import createFFmpegAudio from "./wasm/ffmpeg_wasm";

const THRESHOLD_50MB = 50 * 1024 * 1024;

let ffmpegModule: FFmpegAudioModule | null = null;
let audioData: Uint8Array | null = null;
let audioFile: File | null = null;
const readerSync = new FileReaderSync();

let decoderPtr: number = 0;
let isDecoding = false;
let eofPending = false;

let audioWriter: AudioWriter | null = null;
let targetChannels = 2;
let targetSampleRate = 48000;
const yieldChannel = new MessageChannel();
let isProcessing = false;

let currentSeekGeneration = 0;
let currentSessionId = 0;

const WORKER_MIN_SPACE_REQ_FRAMES = 8192;

yieldChannel.port1.onmessage = () => {
	processFrame();
};

function postEvent(event: WorkerEvent): void {
	self.postMessage(event);
}

function getLastErrorMsg(): string {
	if (!ffmpegModule) return "Wasm module not loaded";

	const err = ffmpegModule.UTF8ToString(ffmpegModule._wasm_get_last_error());

	if (!err) return "Unknown FFmpeg error";
	return err;
}

async function initWasm(ffmpegWasmUrl: string): Promise<FFmpegAudioModule> {
	return await createFFmpegAudio({
		locateFile: () => ffmpegWasmUrl,

		js_get_file_size: (_file_id: number): number => {
			return audioData ? audioData.byteLength : audioFile ? audioFile.size : -1;
		},

		js_read_file: (
			_file_id: number,
			offset: number,
			length: number,
			buffer_ptr: number,
		): number => {
			if (!ffmpegModule) return -1;

			if (audioData) {
				const maxRead = Math.min(length, audioData.byteLength - offset);
				if (maxRead <= 0) return 0;

				const slice = audioData.subarray(offset, offset + maxRead);
				ffmpegModule.HEAPU8.set(slice, buffer_ptr);
				return maxRead;
			}

			if (audioFile) {
				try {
					const blobSlice = audioFile.slice(offset, offset + length);
					const buffer = readerSync.readAsArrayBuffer(blobSlice);
					const u8 = new Uint8Array(buffer);
					ffmpegModule.HEAPU8.set(u8, buffer_ptr);
					return u8.length;
				} catch (err) {
					console.error("Chunk read error:", err);
					return -1;
				}
			}

			return -1;
		},
	});
}

async function processFrame() {
	if (!ffmpegModule || !isDecoding || decoderPtr === 0 || !audioWriter) {
		return;
	}

	if (isProcessing) {
		return;
	}
	isProcessing = true;
	const myGeneration = currentSeekGeneration;
	const mySessionId = currentSessionId;

	try {
		const { async, promise } = audioWriter.waitForSpaceAsync(
			WORKER_MIN_SPACE_REQ_FRAMES,
		);

		if (async && promise) {
			await promise;
			if (mySessionId !== currentSessionId) return;
		} else {
			let status = -1;

			try {
				status = ffmpegModule._wasm_decoder_decode_frame(decoderPtr);
			} catch (wasmErr) {
				console.warn(`Crash during frame decode: ${getErrorMessage(wasmErr)}`);
			}

			if (status === 1) {
				const samples =
					ffmpegModule._wasm_decoder_get_frame_samples(decoderPtr);
				const memoryBuffer = ffmpegModule.wasmMemory.buffer;

				const channelDatas: Float32Array[] = [];
				for (let c = 0; c < targetChannels; c++) {
					const ptr = ffmpegModule._wasm_decoder_get_channel_ptr(decoderPtr, c);
					channelDatas.push(new Float32Array(memoryBuffer, ptr, samples));
				}

				let written = 0;
				while (written < samples) {
					if (
						!isDecoding ||
						myGeneration !== currentSeekGeneration ||
						mySessionId !== currentSessionId
					) {
						return;
					}

					const remaining = samples - written;
					const pushed = audioWriter.writePartial(
						channelDatas,
						written,
						remaining,
					);
					written += pushed;

					if (pushed === 0) {
						const { async, promise } = audioWriter.waitForSpaceAsync(1);
						if (async && promise) {
							await promise;
							if (mySessionId !== currentSessionId) return;
						}
					}
				}
			} else if (status === 0) {
				isDecoding = false;
				eofPending = true;
				checkEofDrained(mySessionId);
				return;
			} else {
				const rawErr = getLastErrorMsg();
				console.warn(`Corrupted frame skipped: ${rawErr}`);
			}
		}
	} catch (globalErr) {
		console.error("Critical error in processFrame loop:", globalErr);
		isDecoding = false;
		postEvent({ type: "DECODE_ERROR", error: getErrorMessage(globalErr) });
	} finally {
		if (mySessionId === currentSessionId) {
			isProcessing = false;
		}

		if (
			myGeneration !== currentSeekGeneration &&
			mySessionId === currentSessionId &&
			isDecoding
		) {
			processFrame();
		}
	}

	if (
		isDecoding &&
		myGeneration === currentSeekGeneration &&
		mySessionId === currentSessionId
	) {
		yieldChannel.port2.postMessage(null);
	}
}

function checkEofDrained(sessionId: number) {
	if (sessionId !== currentSessionId || !eofPending || !audioWriter) return;

	const { isDrained, promise } = audioWriter.waitForDrainAsync();

	if (isDrained) {
		eofPending = false;
		postEvent({ type: "DECODE_EOF" });
		return;
	}

	if (promise) {
		promise.then(() => checkEofDrained(sessionId));
	} else {
		checkEofDrained(sessionId);
	}
}

self.onmessage = async (e: MessageEvent<WorkerCommand>) => {
	const data = e.data;

	if (data.type === "INIT") {
		currentSessionId++;

		isProcessing = false;

		if (decoderPtr !== 0 && ffmpegModule) {
			ffmpegModule._wasm_decoder_destroy(decoderPtr);
			decoderPtr = 0;
		}

		isDecoding = false;
		eofPending = false;
		audioWriter = null;

		try {
			const payload = data.payload;
			if (payload.file.size < THRESHOLD_50MB) {
				const arrayBuffer = await payload.file.arrayBuffer();
				audioData = new Uint8Array(arrayBuffer);
				audioFile = null;
			} else {
				audioFile = payload.file;
				audioData = null;
			}

			targetSampleRate = payload.sampleRate;
			targetChannels = payload.channels;
			audioWriter = createAudioWriter(payload.sharedBuffer);
			ffmpegModule = await initWasm(payload.ffmpegWasmUrl);

			decoderPtr = ffmpegModule._wasm_decoder_create(
				1,
				targetSampleRate,
				targetChannels,
			);

			if (decoderPtr === 0) {
				throw new Error(
					`Decoder Context creation failed: ${getLastErrorMsg()}`,
				);
			}

			const duration = ffmpegModule._wasm_decoder_get_duration(decoderPtr);
			const metadataJsonPtr =
				ffmpegModule._wasm_decoder_get_metadata_json(decoderPtr);
			const metadataJson = ffmpegModule.UTF8ToString(metadataJsonPtr);
			const metadata = JSON.parse(metadataJson);

			let coverBytes: ArrayBuffer | null = null;
			let coverMime: string | null = null;
			const coverSize = ffmpegModule._wasm_decoder_get_cover_size(decoderPtr);

			if (coverSize > 0) {
				const coverPtr = ffmpegModule._wasm_decoder_get_cover_ptr(decoderPtr);
				const memoryBuffer = ffmpegModule.wasmMemory.buffer;
				coverBytes = memoryBuffer.slice(coverPtr, coverPtr + coverSize);
				const mimePtr = ffmpegModule._wasm_decoder_get_cover_mime(decoderPtr);
				if (mimePtr !== 0) coverMime = ffmpegModule.UTF8ToString(mimePtr);
			}

			postEvent({
				type: "INIT_DONE",
				payload: { duration, metadata, coverBytes, coverMime },
			});
		} catch (e) {
			console.error("Worker Init Failed:", e);
			postEvent({ type: "INIT_ERROR", error: getErrorMessage(e) });
		}
	} else if (data.type === "PLAY") {
		if (!isDecoding) {
			isDecoding = true;
			processFrame();
		}
	} else if (data.type === "PAUSE") {
		isDecoding = false;
	} else if (data.type === "SEEK") {
		if (!ffmpegModule || !audioWriter) return;
		eofPending = false;
		currentSeekGeneration++;

		audioWriter.beginSeek();
		const seekStatus = ffmpegModule._wasm_decoder_seek(
			decoderPtr,
			data.payload.targetSeconds,
		);
		audioWriter.endSeek();

		if (seekStatus === -1) {
			postEvent({
				type: "DECODE_ERROR",
				error: `Seek failed at ${data.payload.targetSeconds}s: ${getLastErrorMsg()}`,
			});
			isDecoding = false;
			return;
		}

		if (!isDecoding) {
			isDecoding = true;
		}
		processFrame();
	}
};
