use std::{
    f32::consts::PI,
    hint::black_box,
};

use criterion::{
    Criterion,
    Throughput,
    criterion_group,
    criterion_main,
};
use soundtouch_rs::{
    InterpolationAlgorithm,
    SoundTouch,
};

fn criterion_benchmark(c: &mut Criterion) {
    let channels = 2;
    let sample_rate = 44100;
    let num_frames = sample_rate;

    let mut single_channel = Vec::with_capacity(num_frames);
    for i in 0..num_frames {
        let t = i as f32 / sample_rate as f32;
        single_channel.push((t * 440.0 * 2.0 * PI).sin());
    }

    let input_planar = vec![single_channel; channels];
    let total_samples = num_frames * channels;

    let mut st = SoundTouch::builder(channels, sample_rate)
        .tempo(1.5)
        .pitch_semi_tones(2.0)
        .interpolation_algo(InterpolationAlgorithm::Shannon)
        .build()
        .unwrap();

    let mut output_planar = vec![vec![0.0; 4096]; channels];

    let mut group = c.benchmark_group("SoundTouch Processing");

    group.throughput(Throughput::Elements(total_samples as u64));

    group.bench_function("tempo_1.5_pitch_2.0", |b| {
        b.iter(|| {
            st.clear().unwrap();

            st.put_samples(&input_planar).unwrap();

            loop {
                let frames_read = st.receive_samples(&mut output_planar).unwrap();
                if frames_read == 0 {
                    break;
                }

                for channel in &output_planar {
                    black_box(&channel[..frames_read]);
                }
            }

            st.flush().unwrap();
            loop {
                let frames_read = st.receive_samples(&mut output_planar).unwrap();
                if frames_read == 0 {
                    break;
                }

                for channel in &output_planar {
                    black_box(&channel[..frames_read]);
                }
            }
        });
    });

    group.finish();
}

criterion_group! {
    name = benches;
    config = Criterion::default().measurement_time(std::time::Duration::from_secs(5));
    targets = criterion_benchmark
}

criterion_main!(benches);
