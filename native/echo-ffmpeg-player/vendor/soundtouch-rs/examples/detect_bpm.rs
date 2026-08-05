use std::{
    env,
    fs::File,
    time::Instant,
};

use anyhow::Result;
use ffmpeg_audio::{
    AudioReader,
    ResampleOptions,
};
use soundtouch_rs::bpm_detect::BpmDetect;

fn main() -> Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: cargo run --example detect_bpm -- <file path>");
        eprintln!("Example: cargo run --example detect_bpm -- music.mp3");
        std::process::exit(1);
    }

    let file_path = &args[1];

    let file = File::open(file_path)?;
    let reader = AudioReader::new(file)?;

    let options = ResampleOptions::new()
        .sample_rate(44100)
        .channels(2)
        .format_planar::<f32>();

    let mut resampled = reader.into_resampled(options)?;

    let info = resampled.source().source_info();
    println!(
        "Decode success: {} ({} Hz, {} channels)",
        info.codec_name.as_deref().unwrap_or("unknown"),
        info.sample_rate,
        info.channels
    );

    let mut bpm_detector = BpmDetect::new(2, 44100)?;

    let start_time = Instant::now();

    let mut total_frames = 0;
    while let Some(channels_data) = resampled.receive_planar_as::<f32>()? {
        if channels_data.is_empty() || channels_data[0].is_empty() {
            continue;
        }
        total_frames += channels_data[0].len();
        bpm_detector.put_samples(&channels_data)?;
    }

    let duration = start_time.elapsed();
    println!("Processed {total_frames} audio frames in {duration:?}");

    if let Some(bpm) = bpm_detector.get_bpm() {
        println!("BPM Detected: {bpm:.2}");
    } else {
        println!("We didn't detect sufficiently clear dynamic characteristics");
    }

    let mut beats: Vec<_> = bpm_detector.drain_beats().collect();
    if !beats.is_empty() {
        beats.truncate(10);
        for (idx, beat) in beats.iter().enumerate() {
            println!(
                "  [{:02}]: Time: {:7.3}s | Strength: {:.2}",
                idx + 1,
                beat.pos,
                beat.strength
            );
        }
    }

    Ok(())
}
