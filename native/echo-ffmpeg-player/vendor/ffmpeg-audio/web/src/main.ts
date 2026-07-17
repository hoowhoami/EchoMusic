import { FFmpegAudioEngine } from "./audio-core";
import workerUrl from "./audio-core/worker/decoder.worker.ts?worker&url";
import ffmpegWasmUrl from "./audio-core/worker/wasm/ffmpeg_wasm.wasm?url";
import workletUrl from "./audio-core/worklet/audio.worklet.ts?worker&url";
import soundtouchWasmUrl from "./audio-core/worklet/wasm/soundtouch_bg.wasm?url";
import { AppUI } from "./ui";

async function bootstrap() {
	const AudioContextClass =
		// biome-ignore lint/suspicious/noExplicitAny: For compatibility
		window.AudioContext || (window as any).webkitAudioContext;
	const audioCtx = new AudioContextClass();
	await audioCtx.suspend();

	const mainGainNode = audioCtx.createGain();
	mainGainNode.gain.value = 1.0;
	mainGainNode.connect(audioCtx.destination);

	const engine = new FFmpegAudioEngine({
		audioContext: audioCtx,
		gainNode: mainGainNode,
		assets: {
			workerUrl,
			workletUrl,
			ffmpegWasmUrl,
			soundtouchWasmUrl,
		},
	});

	new AppUI(engine);
}

bootstrap().catch((err) => {
	console.error("Application failed to bootstrap:", err);
});
