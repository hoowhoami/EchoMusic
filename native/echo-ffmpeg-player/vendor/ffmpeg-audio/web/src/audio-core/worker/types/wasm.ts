export interface FFmpegAudioConfig {
	locateFile: (path: string, scriptDirectory: string) => string;
	js_get_file_size: (file_id: number) => number;
	js_read_file: (
		file_id: number,
		offset: number,
		length: number,
		buffer_ptr: number,
	) => number;
}

export interface FFmpegAudioModule {
	wasmMemory: WebAssembly.Memory;

	HEAP8: Int8Array;
	HEAPU8: Uint8Array;
	HEAP16: Int16Array;
	HEAPU16: Uint16Array;
	HEAP32: Int32Array;
	HEAPU32: Uint32Array;
	HEAPF32: Float32Array;
	HEAPF64: Float64Array;
	HEAP64: BigInt64Array;
	HEAPU64: BigUint64Array;

	getValue(
		ptr: number,
		type?: "i1" | "i8" | "i16" | "i32" | "i64" | "float" | "double" | "*",
	): number | bigint;
	setValue(
		ptr: number,
		value: number | bigint,
		type?: "i1" | "i8" | "i16" | "i32" | "i64" | "float" | "double" | "*",
	): void;

	_wasm_decoder_create(
		mode: number,
		sampleRate: number,
		channels: number,
	): number;
	_wasm_decoder_destroy(decoderPtr: number): number;

	_wasm_decoder_decode_frame(decoderPtr: number): number;
	_wasm_decoder_get_frame_samples(decoderPtr: number): number;
	_wasm_decoder_get_frame_min(decoderPtr: number): number;
	_wasm_decoder_get_frame_max(decoderPtr: number): number;
	_wasm_decoder_get_channel_ptr(
		decoderPtr: number,
		channelIndex: number,
	): number;
	_wasm_decoder_get_duration(decoderPtr: number): number;
	_wasm_decoder_seek(decoderPtr: number, targetSeconds: number): number;
	_wasm_decoder_get_metadata_json(decoderPtr: number): number;
	_wasm_decoder_get_cover_ptr(decoderPtr: number): number;
	_wasm_decoder_get_cover_size(decoderPtr: number): number;
	_wasm_decoder_get_cover_mime(decoderPtr: number): number;

	_wasm_decoder_set_compute_peaks(decoderPtr: number, enable: number): number;

	_wasm_get_last_error(): number;

	UTF8ToString(
		ptr: number,
		maxBytesToRead?: number,
		ignoreNul?: boolean,
	): string;
}
