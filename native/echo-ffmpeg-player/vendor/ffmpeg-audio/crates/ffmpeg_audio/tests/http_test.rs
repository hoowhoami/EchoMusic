#![cfg(feature = "http")]

use std::time::Duration;

use ffmpeg_audio::{
    AudioReader,
    HttpAudioSource,
};
use tracing_subscriber::{
    EnvFilter,
    fmt,
};

#[test]
#[ignore = "Needs network connection"]
fn http_test() {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug")),
        )
        .try_init()
        .unwrap();

    let url = "http://127.0.0.1:8080";

    println!("Connecting to {url}...");
    let source = HttpAudioSource::new(url).expect("Failed to initialize HTTP source");

    let mut reader = AudioReader::new(source).expect("Failed to create AudioReader");

    let duration = reader.duration().unwrap();
    println!("Duration: {duration:?}");

    println!("Seeking to 10s...");
    reader.seek(Duration::from_secs(10)).unwrap();

    println!("Reading some frames...");
    for _ in 0..5 {
        let frame = reader.receive_frame().unwrap();
        if frame.is_some() {
            println!("Successfully read a frame");
        }
    }
}
