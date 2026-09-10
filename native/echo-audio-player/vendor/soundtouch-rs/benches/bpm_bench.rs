use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use soundtouch_rs::bpm_detect::BpmDetect;

fn generate_synth_signal(sample_rate: usize, duration_secs: usize) -> Vec<Vec<f32>> {
    let num_frames = sample_rate * duration_secs;
    let mut left = vec![0.0; num_frames];
    let mut right = vec![0.0; num_frames];
    let beat_interval = sample_rate / 2;

    for i in 0..num_frames {
        let t = i as f32 / sample_rate as f32;
        let carrier = (t * 440.0 * 2.0 * std::f32::consts::PI).sin();

        let dist_from_beat = (i % beat_interval) as f32 / sample_rate as f32;
        let envelope = (-30.0 * dist_from_beat).exp();

        let sample = carrier * envelope;
        left[i] = sample;
        right[i] = sample;
    }
    vec![left, right]
}

fn bench_bpm_detection(c: &mut Criterion) {
    let sample_rate = 44100;
    let duration_secs = 5;
    let channels_data = generate_synth_signal(sample_rate, duration_secs);
    let num_frames = channels_data[0].len();
    let total_samples = num_frames * 2;

    let mut group = c.benchmark_group("BPM Detection");
    group.throughput(Throughput::Elements(total_samples as u64));

    group.bench_function("Rust_BpmDetect_44100Hz_Stereo_5s", |b| {
        b.iter(|| {
            let mut bpm_detector = BpmDetect::new(2, sample_rate).unwrap();

            let chunk_size = 2048;
            let mut start = 0;
            while start < num_frames {
                let end = (start + chunk_size).min(num_frames);
                let chunk = [&channels_data[0][start..end], &channels_data[1][start..end]];
                bpm_detector.put_samples(&chunk).unwrap();
                start = end;
            }

            let _bpm = bpm_detector.get_bpm();
        });
    });

    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(50);
    targets = bench_bpm_detection
}
criterion_main!(benches);
