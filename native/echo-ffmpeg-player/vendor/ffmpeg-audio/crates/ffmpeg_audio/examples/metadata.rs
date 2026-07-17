use std::{
    env,
    fs::File,
    path::Path,
};

use anyhow::Context;
use ffmpeg_audio::AudioReader;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: {} <音频文件路径>", args[0]);
        eprintln!("示例: {} ./test_audio.m4a", args[0]);
        std::process::exit(1);
    }
    let file_path = &args[1];

    let file = File::open(file_path).context("无法打开音频文件")?;
    let reader = AudioReader::new(file).context("无法初始化音频解码器")?;

    let info = reader.source_info();
    println!(
        "编码器:   {}",
        info.codec_name.as_deref().unwrap_or("unknown")
    );
    println!(
        "采样格式: {}",
        info.sample_fmt.as_deref().unwrap_or("unknown")
    );
    println!("采样率:   {} Hz", info.sample_rate);
    println!("声道数:   {}", info.channels);
    println!("码率:     {} kbps", info.bit_rate / 1000);
    if let Some(dur) = reader.duration() {
        println!("时长:     {:.3} s", dur.as_secs_f64());
    } else {
        println!("时长:     (未知)");
    }

    println!("\n=== 音频元数据 ===");
    let metadata = reader.metadata();
    if metadata.is_empty() {
        println!("(未找到任何元数据标签)");
    } else {
        for key in metadata.keys() {
            println!("{} : {}", key, metadata[key]);
        }
    }

    if let Some(cover) = reader.cover() {
        let extension = match cover.mime_type.as_deref() {
            Some("image/jpeg") => "jpg",
            Some("image/png") => "png",
            Some("image/bmp") => "bmp",
            Some("image/gif") => "gif",
            _ => "bin",
        };

        let base_name = Path::new(file_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("audio");

        let out_filename = format!("{base_name}_cover.{extension}");

        println!(
            "封面图片 MIME 类型: {}",
            cover.mime_type.as_deref().unwrap_or("unknown")
        );

        std::fs::write(&out_filename, cover.data)?;
        println!("保存封面至: ./{out_filename}");
    }

    Ok(())
}
