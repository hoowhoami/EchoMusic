import type { FFmpegAudioEngine } from "./audio-core";

export class AppUI {
	private openBtn = document.getElementById("open-btn") as HTMLButtonElement;
	private playBtn = document.getElementById("play-btn") as HTMLButtonElement;
	private pauseBtn = document.getElementById("pause-btn") as HTMLButtonElement;
	private seekBar = document.getElementById("seek-bar") as HTMLInputElement;
	private timeCurrent = document.getElementById(
		"time-current",
	) as HTMLSpanElement;
	private timeTotal = document.getElementById("time-total") as HTMLSpanElement;
	private trackInfo = document.getElementById("track-info") as HTMLDivElement;
	private coverArt = document.getElementById("cover-art") as HTMLDivElement;
	private metadataDiv = document.getElementById("metadata") as HTMLDivElement;

	private sliderVolume = document.getElementById(
		"slider-volume",
	) as HTMLInputElement;
	private valVolume = document.getElementById("val-volume") as HTMLSpanElement;

	private sliderTempo = document.getElementById(
		"slider-tempo",
	) as HTMLInputElement;
	private valTempo = document.getElementById("val-tempo") as HTMLSpanElement;

	private sliderPitch = document.getElementById(
		"slider-pitch",
	) as HTMLInputElement;
	private valPitch = document.getElementById("val-pitch") as HTMLSpanElement;

	private sliderRate = document.getElementById(
		"slider-rate",
	) as HTMLInputElement;
	private valRate = document.getElementById("val-rate") as HTMLSpanElement;

	private btnResetDsp = document.getElementById(
		"btn-reset-dsp",
	) as HTMLButtonElement;

	private isDragging = false;
	private currentCoverUrl: string | null = null;

	constructor(private engine: FFmpegAudioEngine) {
		this.bindDomEvents();
		this.bindEngineEvents();
	}

	//#region Bind Events
	private bindDomEvents(): void {
		this.openBtn.addEventListener("click", () => this.handleOpenFile());

		this.playBtn.addEventListener("click", () => {
			this.engine.play();
		});

		this.pauseBtn.addEventListener("click", () => {
			this.engine.pause();
		});

		this.seekBar.addEventListener("input", (e) => {
			this.isDragging = true;
			const targetSeconds = parseFloat((e.target as HTMLInputElement).value);
			this.timeCurrent.textContent = this.formatTime(targetSeconds);
		});

		this.sliderVolume.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			this.valVolume.textContent = `${Math.round(val * 100)}%`;
			this.engine.volume = val;
		});

		this.seekBar.addEventListener("change", (e) => {
			this.isDragging = false;
			const targetSeconds = parseFloat((e.target as HTMLInputElement).value);
			this.engine.currentTime = targetSeconds;
		});

		this.sliderTempo.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			this.valTempo.textContent = `${val.toFixed(2)}x`;
			this.engine.tempo = val;
		});

		this.sliderPitch.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			this.valPitch.textContent = `${val.toFixed(2)}x`;
			this.engine.pitch = val;
		});

		this.sliderRate.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value);
			this.valRate.textContent = `${val.toFixed(2)}x`;
			this.engine.rate = val;
		});

		this.btnResetDsp.addEventListener("click", () => {
			this.resetDspSliders();
		});
	}

	private bindEngineEvents(): void {
		this.engine.addEventListener("loadedmetadata", () => {
			this.seekBar.max = this.engine.duration.toString();
			this.timeTotal.textContent = this.formatTime(this.engine.duration);
			this.openBtn.textContent = "Loaded";
			this.openBtn.disabled = false;
			this.playBtn.disabled = false;
			this.pauseBtn.disabled = false;
			this.seekBar.disabled = false;
			this.sliderVolume.disabled = false;

			this.sliderTempo.disabled = false;
			this.sliderPitch.disabled = false;
			this.sliderRate.disabled = false;
			this.btnResetDsp.disabled = false;

			this.renderTrackInfo();
		});

		this.engine.addEventListener("timeupdate", () => {
			if (this.isDragging) return;
			const secs = this.engine.currentTime;
			this.seekBar.value = secs.toString();
			this.timeCurrent.textContent = this.formatTime(secs);
		});

		this.engine.addEventListener("ended", () => {
			this.playBtn.disabled = true;
			this.pauseBtn.disabled = true;
		});

		this.engine.addEventListener("error", (e) => {
			console.error("Player error:", e.detail);
			this.openBtn.disabled = false;
			this.openBtn.textContent = "Select Audio File (Error)";
		});
	}
	//#endregion

	//#region Actions & Rendering

	private resetDspSliders(): void {
		this.sliderTempo.value = "1.0";
		this.valTempo.textContent = "1.00x";
		this.engine.tempo = 1.0;

		this.sliderPitch.value = "1.0";
		this.valPitch.textContent = "1.00x";
		this.engine.pitch = 1.0;

		this.sliderRate.value = "1.0";
		this.valRate.textContent = "1.00x";
		this.engine.rate = 1.0;
	}

	private async handleOpenFile(): Promise<void> {
		try {
			const [fileHandle] = await window.showOpenFilePicker({
				types: [
					{
						description: "Audio Files",
						accept: {
							"audio/*": [
								".flac",
								".wav",
								".m4a",
								".alac",
								".ape",
								".mac",
								".wv",
								".tta",
								".tak",
								".aiff",
								".aif",
								".aifc",
								".mp3",
								".aac",
								".mp4",
								".ogg",
								".oga",
								".opus",
								".wma",
								".asf",
								".mpc",
								".mpp",
								".mp+",
								".dsf",
								".ac3",
								".eac3",
								".dts",
								".dtshd",
								".thd",
								".mlp",
								".mka",
								".amr",
								".rm",
								".ra",
								".au",
								".snd",
								".caf",
								".w64",
								".iff",
								".8svx",
							],
						},
					},
				],
			});

			const file = await fileHandle.getFile();

			this.openBtn.disabled = true;
			this.openBtn.textContent = "Loading...";
			this.resetDspSliders();

			await this.engine.loadFile(file);
		} catch (err) {
			if ((err as Error).name !== "AbortError") {
				console.error("File Selection Failed", err);
			}
			this.openBtn.disabled = false;
			this.openBtn.textContent = "Select Audio File";
		}
	}

	private renderTrackInfo(): void {
		if (this.currentCoverUrl) {
			URL.revokeObjectURL(this.currentCoverUrl);
			this.currentCoverUrl = null;
		}

		const cover = this.engine.cover;
		if (cover && cover.bytes.byteLength > 0) {
			const blob = new Blob([cover.bytes], {
				type: cover.mime ?? "image/jpeg",
			});
			this.currentCoverUrl = URL.createObjectURL(blob);
			this.coverArt.innerHTML = `<img src="${this.currentCoverUrl}" alt="Cover Art">`;
		} else {
			this.coverArt.innerHTML = '<span class="placeholder">&#9835;</span>';
		}

		this.metadataDiv.innerHTML = "";
		const entries = Object.entries(this.engine.metadata);
		for (const [key, value] of entries) {
			const item = document.createElement("div");
			item.className = "meta-item";

			const keySpan = document.createElement("span");
			keySpan.className = "meta-key";
			keySpan.textContent = `${key}:`;

			const valueSpan = document.createElement("span");
			valueSpan.className = "meta-value";
			valueSpan.textContent = value;

			item.appendChild(keySpan);
			item.appendChild(valueSpan);
			this.metadataDiv.appendChild(item);
		}

		this.trackInfo.classList.add("visible");
	}

	private formatTime(seconds: number): string {
		if (seconds < 0 || Number.isNaN(seconds)) return "00:00";
		const m = Math.floor(seconds / 60)
			.toString()
			.padStart(2, "0");
		const s = Math.floor(seconds % 60)
			.toString()
			.padStart(2, "0");
		return `${m}:${s}`;
	}
	//#endregion
}
