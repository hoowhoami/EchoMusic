import type { FFmpegAudioConfig, FFmpegAudioModule } from "../types";

declare function createFFmpegAudio(
	config: FFmpegAudioConfig,
): Promise<FFmpegAudioModule>;
export default createFFmpegAudio;
