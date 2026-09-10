#[cfg(not(target_arch = "wasm32"))]
use std::{env, fs::File, thread, time::Duration};

#[cfg(not(target_arch = "wasm32"))]
use anyhow::Context;
#[cfg(not(target_arch = "wasm32"))]
use cpal::traits::{DeviceTrait as _, HostTrait as _, StreamTrait as _};
#[cfg(not(target_arch = "wasm32"))]
use ffmpeg_audio::{AudioReader, ResampleOptions, ScanMode, log::init_ffmpeg_logging};
#[cfg(not(target_arch = "wasm32"))]
use ringbuf::{
    HeapRb,
    traits::{Consumer as _, Observer as _, Producer as _, Split as _},
};
#[cfg(not(target_arch = "wasm32"))]
use soundtouch_rs::SoundTouch;
#[cfg(all(feature = "spectral", not(target_arch = "wasm32")))]
use soundtouch_rs::{SpectralPreset, SpectralStretch};
#[cfg(not(target_arch = "wasm32"))]
use tracing_subscriber::{EnvFilter, fmt};

#[cfg(not(target_arch = "wasm32"))]
struct CppSignalsmithEngine {
    inner: signalsmith_stretch::Stretch,
    channels: usize,
    tempo: f64,
    output_fifo: HeapRb<f32>,
}

#[cfg(not(target_arch = "wasm32"))]
impl CppSignalsmithEngine {
    fn new(
        channels: usize,
        sample_rate: usize,
        tempo: f64,
        pitch_semitones: f64,
        formant_factor: f64,
    ) -> Self {
        let mut inner =
            signalsmith_stretch::Stretch::preset_default(channels as u32, sample_rate as u32);
        inner.set_transpose_factor_semitones(pitch_semitones as f32, None);
        inner.set_formant_factor(formant_factor as f32, false);

        let capacity = sample_rate * channels * 10;
        Self {
            inner,
            channels,
            tempo,
            output_fifo: HeapRb::<f32>::new(capacity),
        }
    }

    fn put_samples(&mut self, data: &[impl AsRef<[f32]>]) {
        if data.is_empty() || data[0].as_ref().is_empty() {
            return;
        }

        let input_frames = data[0].as_ref().len();
        let mut interleaved_input = Vec::with_capacity(input_frames * self.channels);

        for i in 0..input_frames {
            for channel in data.iter().take(self.channels) {
                interleaved_input.push(channel.as_ref()[i]);
            }
        }

        let output_frames = (input_frames as f64 / self.tempo).round() as usize;
        let mut interleaved_output = vec![0.0f32; output_frames * self.channels];

        self.inner
            .process(&interleaved_input, &mut interleaved_output);

        // This example uses a fixed-capacity FIFO and drops overflow instead of blocking playback.
        for sample in interleaved_output {
            let _ = self.output_fifo.try_push(sample);
        }
    }

    fn receive_samples(&mut self, output: &mut [impl AsMut<[f32]>]) -> usize {
        if output.is_empty() || output[0].as_mut().is_empty() {
            return 0;
        }

        let requested_frames = output[0].as_mut().len();
        let available_frames = self.output_fifo.occupied_len() / self.channels;
        let frames_to_read = requested_frames.min(available_frames);

        for i in 0..frames_to_read {
            for channel in output.iter_mut().take(self.channels) {
                channel.as_mut()[i] = self.output_fifo.try_pop().unwrap_or(0.0);
            }
        }

        frames_to_read
    }

    fn flush(&mut self) {
        let mut flush_buf = vec![0.0f32; self.inner.output_latency() * self.channels];
        self.inner.flush(&mut flush_buf);
        // This example uses a fixed-capacity FIFO and drops overflow instead of blocking playback.
        for sample in flush_buf {
            let _ = self.output_fifo.try_push(sample);
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
enum AudioEngine {
    SoundTouch(SoundTouch),
    #[cfg(feature = "spectral")]
    Spectral(SpectralStretch),
    CppSignalsmith(CppSignalsmithEngine),
}

#[cfg(not(target_arch = "wasm32"))]
impl AudioEngine {
    fn put_samples(&mut self, data: &[impl AsRef<[f32]>]) -> soundtouch_rs::Result<()> {
        match self {
            Self::SoundTouch(st) => st.put_samples(data),
            #[cfg(feature = "spectral")]
            Self::Spectral(sp) => sp.put_samples(data),
            Self::CppSignalsmith(cpp) => {
                cpp.put_samples(data);
                Ok(())
            }
        }
    }

    fn receive_samples(
        &mut self,
        output: &mut [impl AsMut<[f32]>],
    ) -> soundtouch_rs::Result<usize> {
        match self {
            Self::SoundTouch(st) => st.receive_samples(output),
            #[cfg(feature = "spectral")]
            Self::Spectral(sp) => sp.receive_samples(output),
            Self::CppSignalsmith(cpp) => Ok(cpp.receive_samples(output)),
        }
    }

    fn flush(&mut self) -> soundtouch_rs::Result<()> {
        match self {
            Self::SoundTouch(st) => st.flush(),
            #[cfg(feature = "spectral")]
            Self::Spectral(sp) => sp.flush(),
            Self::CppSignalsmith(cpp) => {
                cpp.flush();
                Ok(())
            }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::too_many_lines)]
fn main() -> anyhow::Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug")),
        )
        .init();

    init_ffmpeg_logging();

    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "用法: {} <音频文件路径> [--tempo <倍数>] [--pitch <半音>] [--algo <spectral|cpp|soundtouch>] [--formant <倍数>]",
            args[0]
        );
        std::process::exit(1);
    }

    let file_path = &args[1];

    let mut target_tempo = 1.0;
    let mut target_pitch = 0.0;
    let mut target_formant: f64 = 1.0;
    let default_algo = if cfg!(feature = "spectral") {
        "spectral"
    } else {
        "soundtouch"
    };
    let mut algo_name = default_algo.to_string();

    for i in 1..args.len() {
        if args[i] == "--tempo" && i + 1 < args.len() {
            target_tempo = args[i + 1].parse().unwrap_or(1.0);
        }
        if args[i] == "--pitch" && i + 1 < args.len() {
            target_pitch = args[i + 1].parse().unwrap_or(0.0);
        }
        if args[i] == "--algo" && i + 1 < args.len() {
            algo_name = args[i + 1].to_lowercase();
        }
        if args[i] == "--formant" && i + 1 < args.len() {
            target_formant = args[i + 1].parse().unwrap_or(1.0);
        }
    }

    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .context("未找到默认音频输出设备")?;

    let config = device.default_output_config()?;
    let sample_rate = config.sample_rate();
    let channels = config.channels() as usize;

    println!("🎵 声卡已就绪: {sample_rate} Hz, {channels} 声道");

    let mut engine = match algo_name.as_str() {
        "soundtouch" | "wsola" => {
            println!("   算法: SoundTouch (WSOLA 时域算法)");
            println!("   速度: x{target_tempo}, 音调: {target_pitch} 半音");
            if (target_formant - 1.0).abs() > f64::EPSILON {
                eprintln!("   警告: SoundTouch 算法不支持 formant 映射，已忽略该参数");
            }
            let st = SoundTouch::builder(channels, sample_rate as usize)
                .tempo(target_tempo)
                .pitch_semi_tones(target_pitch)
                .interpolation_algo(soundtouch_rs::InterpolationAlgorithm::Shannon)
                .build()?;
            AudioEngine::SoundTouch(st)
        }
        "cpp" | "cpp-signalsmith" | "signalsmith-cpp" => {
            println!("   算法: C++ Signalsmith Stretch");
            println!("   速度: x{target_tempo}, 音调: {target_pitch} 半音");
            let cpp_engine = CppSignalsmithEngine::new(
                channels,
                sample_rate as usize,
                target_tempo,
                target_pitch,
                target_formant,
            );
            AudioEngine::CppSignalsmith(cpp_engine)
        }
        #[cfg(feature = "spectral")]
        "spectral" | "rust-spectral" => {
            println!("   算法: Rust Spectral");
            println!("   速度: x{target_tempo}, 音调: {target_pitch} 半音");
            let sp = SpectralStretch::builder(channels, sample_rate as usize)
                .preset(SpectralPreset::Default)
                .tempo(target_tempo)
                .pitch_semi_tones(target_pitch)
                .formant_factor(target_formant, false)
                .build()?;
            AudioEngine::Spectral(sp)
        }
        #[cfg(not(feature = "spectral"))]
        "spectral" | "rust-spectral" => {
            anyhow::bail!("编译时未启用 `spectral` 特性。请使用 `--features spectral` 编译运行。");
        }
        _ => {
            #[cfg(feature = "spectral")]
            {
                println!("   算法: Rust Spectral (默认)");
                println!("   速度: x{target_tempo}, 音调: {target_pitch} 半音");
                let sp = SpectralStretch::builder(channels, sample_rate as usize)
                    .preset(SpectralPreset::Default)
                    .tempo(target_tempo)
                    .pitch_semi_tones(target_pitch)
                    .formant_factor(target_formant, false)
                    .build()?;
                AudioEngine::Spectral(sp)
            }
            #[cfg(not(feature = "spectral"))]
            {
                println!("   算法: SoundTouch (WSOLA 时域算法，默认)");
                println!("   速度: x{target_tempo}, 音调: {target_pitch} 半音");
                let st = SoundTouch::builder(channels, sample_rate as usize)
                    .tempo(target_tempo)
                    .pitch_semi_tones(target_pitch)
                    .interpolation_algo(soundtouch_rs::InterpolationAlgorithm::Shannon)
                    .build()?;
                AudioEngine::SoundTouch(st)
            }
        }
    };

    let file = File::open(file_path).context("无法打开音频文件")?;
    let reader = AudioReader::new(file).context("无法初始化音频解码器")?;

    let quick_duration = reader.duration();

    let options = ResampleOptions::new()
        .sample_rate(i32::try_from(sample_rate)?)
        .channels(i32::try_from(channels)?)
        .format_planar::<f32>();

    let mut resampled = reader.into_resampled(options)?;

    let info = resampled.source().source_info();
    println!(
        "📄 源文件信息: {} ({} Hz, {} 声道)",
        info.codec_name.as_deref().unwrap_or("unknown"),
        info.sample_rate,
        info.channels
    );

    let duration_info = if let Some(dur) = quick_duration {
        Some(dur)
    } else if let Some(dur) = resampled.scan_exact_duration(ScanMode::Packet)? {
        Some(dur)
    } else {
        resampled.scan_exact_duration(ScanMode::Frame)?
    };

    if let Some(d) = duration_info {
        let total_secs = d.as_secs();
        let minutes = total_secs / 60;
        let seconds = total_secs % 60;
        let millis = d.subsec_millis();
        println!("⏱️ 原始音频时长: {minutes:02}:{seconds:02}.{millis:03}");
    } else {
        println!("⚠️ 无法获取该文件的时长");
    }

    let buffer_capacity = (sample_rate * channels as u32 * 4) as usize;
    let rb = HeapRb::<f32>::new(buffer_capacity);
    let (mut producer, mut consumer) = rb.split();

    let err_fn = |err| eprintln!("声卡输出流发生错误: {err}");
    let cpal_config = config.config();

    let stream = device.build_output_stream(
        cpal_config,
        move |data: &mut [f32], _: &cpal::OutputCallbackInfo| {
            for sample in data.iter_mut() {
                *sample = consumer.try_pop().unwrap_or(0.0);
            }
        },
        err_fn,
        None,
    )?;

    stream.play()?;
    println!("▶️ 开始播放...");

    const CHUNK_SIZE: usize = 4096;
    let mut st_out_planar = vec![vec![0.0; CHUNK_SIZE]; channels];
    let mut interleaved_buf = vec![0.0; CHUNK_SIZE * channels];

    macro_rules! pull_from_engine {
        () => {
            loop {
                let frames_read = engine.receive_samples(&mut st_out_planar)?;
                if frames_read == 0 {
                    break;
                }

                for i in 0..frames_read {
                    for ch in 0..channels {
                        interleaved_buf[i * channels + ch] = st_out_planar[ch][i];
                    }
                }

                let valid_samples = &interleaved_buf[..frames_read * channels];
                let mut written = 0;

                while written < valid_samples.len() {
                    let pushed = producer.push_slice(&valid_samples[written..]);
                    written += pushed;

                    if pushed == 0 {
                        thread::sleep(Duration::from_millis(1));
                    }
                }
            }
        };
    }

    while let Some(channels_data) = resampled.receive_planar_as::<f32>()? {
        if channels_data.is_empty() {
            continue;
        }
        let samples_per_channel = channels_data[0].len();
        if samples_per_channel == 0 {
            continue;
        }

        if !channels_data
            .iter()
            .all(|ch| ch.len() == samples_per_channel)
        {
            continue;
        }

        engine.put_samples(&channels_data)?;
        pull_from_engine!();
    }

    engine.flush()?;
    pull_from_engine!();

    while !producer.is_empty() {
        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}
