//! Audio file metadata extraction.

use std::path::Path;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::probe::Hint;

/// Extract duration from an audio file.
///
/// Returns duration in seconds, or None if it cannot be determined.
pub fn get_audio_duration(path: &Path) -> Option<f64> {
    // Open the file
    let file = std::fs::File::open(path).ok()?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());

    // Create a hint based on file extension
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }

    // Probe the file
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &Default::default())
        .ok()?;

    let format = probed.format;

    // Get the default track
    let track = format.default_track()?;

    // Calculate duration from codec params if available
    if let Some(n_frames) = track.codec_params.n_frames {
        if let Some(sample_rate) = track.codec_params.sample_rate {
            let duration_secs = n_frames as f64 / sample_rate as f64;
            return Some(duration_secs);
        }
    }

    // Try to calculate from time base and duration
    if let (Some(time_base), Some(n_frames)) = (track.codec_params.time_base, track.codec_params.n_frames) {
        let duration_secs = time_base.calc_time(n_frames).seconds as f64
            + time_base.calc_time(n_frames).frac;
        return Some(duration_secs);
    }

    None
}
