#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::too_many_lines)]
fn main() -> anyhow::Result<()> {
    use std::{
        env,
        fs::File,
        thread,
        time::Duration,
    };

    use anyhow::Context;
    use cpal::traits::{
        DeviceTrait as _,
        HostTrait as _,
        StreamTrait as _,
    };
    use ffmpeg_audio::{
        AudioReader,
        ResampleOptions,
        ScanMode,
        log::init_ffmpeg_logging,
    };
    use ringbuf::{
        HeapRb,
        traits::{
            Consumer as _,
            Observer as _,
            Producer as _,
            Split as _,
        },
    };
    use soundtouch_rs::SoundTouch;
    use tracing_subscriber::{
        EnvFilter,
        fmt,
    };

    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug")),
        )
        .init();

    init_ffmpeg_logging();

    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "用法: {} <音频文件路径> [--tempo <倍数>] [--pitch <半音>]",
            args[0]
        );
        eprintln!("示例: {} music.mp3 --tempo 1.5 --pitch 2.0", args[0]);
        std::process::exit(1);
    }

    let file_path = &args[1];

    let mut target_tempo = 1.0;
    let mut target_pitch = 0.0;
    for i in 1..args.len() {
        if args[i] == "--tempo" && i + 1 < args.len() {
            target_tempo = args[i + 1].parse().unwrap_or(1.0);
        }
        if args[i] == "--pitch" && i + 1 < args.len() {
            target_pitch = args[i + 1].parse().unwrap_or(0.0);
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

    let mut st = SoundTouch::builder(channels, sample_rate as usize)
        .tempo(target_tempo)
        .pitch_semi_tones(target_pitch)
        .interpolation_algo(soundtouch_rs::InterpolationAlgorithm::Shannon)
        .build()?;

    println!("SoundTouch: 速度 x{target_tempo}, 音调 {target_pitch} 半音");

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

    macro_rules! pull_from_soundtouch {
        () => {
            loop {
                let frames_read = st.receive_samples(&mut st_out_planar)?;
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

        st.put_samples(&channels_data)?;
        pull_from_soundtouch!();
    }

    st.flush()?;
    pull_from_soundtouch!();

    while !producer.is_empty() {
        thread::sleep(Duration::from_millis(10));
    }

    Ok(())
}

#[cfg(target_arch = "wasm32")]
fn main() {}
