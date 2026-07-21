use crate::shared::{FilterInput, SharedAudio, TARGET_CHANNELS};
use crate::tempo::TempoProcessor;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

const FILTER_INPUT_FRAMES: usize = 2048;

pub fn spawn_filter_thread(shared: Arc<SharedAudio>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("player-filter".to_string())
        .spawn(move || run_filter(shared))
        .expect("failed to spawn player filter thread")
}

fn run_filter(shared: Arc<SharedAudio>) {
    let mut generation = shared.current_filter_generation();
    let mut tempo = match TempoProcessor::new(shared.speed(), shared.sample_rate) {
        Ok(tempo) => tempo,
        Err(err) => {
            shared.mark_decode_failed();
            crate::decoder::emit_decode_error(err);
            return;
        }
    };
    let mut input = Vec::<f32>::new();
    let mut output = Vec::<f32>::new();

    loop {
        if shared.stop.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let current_generation = shared.current_filter_generation();
        if current_generation != generation {
            generation = current_generation;
            tempo = match TempoProcessor::new(shared.speed(), shared.sample_rate) {
                Ok(tempo) => tempo,
                Err(err) => {
                    shared.mark_decode_failed();
                    crate::decoder::emit_decode_error(err);
                    return;
                }
            };
            output.clear();
        }

        match shared.pop_decoded_for_filter(
            &mut input,
            FILTER_INPUT_FRAMES * TARGET_CHANNELS,
            generation,
        ) {
            FilterInput::Samples => {
                let speed = shared.speed();
                if let Err(err) = tempo
                    .set_speed(speed)
                    .and_then(|_| tempo.process_into(&input, &mut output))
                {
                    shared.mark_decode_failed();
                    crate::decoder::emit_decode_error(err);
                    return;
                }
                push_filter_output(&shared, &mut output, speed, generation);
            }
            FilterInput::Eof => {
                if let Err(err) = tempo.finish_into(&mut output) {
                    shared.mark_decode_failed();
                    crate::decoder::emit_decode_error(err);
                    return;
                }
                let speed = tempo.speed();
                push_filter_output(&shared, &mut output, speed, generation);
                if shared.is_filter_generation_current(generation) {
                    shared.mark_eof();
                }
                while shared.is_filter_generation_current(generation)
                    && !shared.stop.load(std::sync::atomic::Ordering::Acquire)
                {
                    thread::sleep(Duration::from_millis(20));
                }
            }
            FilterInput::Stopped => {
                thread::sleep(Duration::from_millis(2));
            }
        }
    }
}

fn push_filter_output(
    shared: &SharedAudio,
    output: &mut Vec<f32>,
    speed: f32,
    generation: u64,
) -> bool {
    if output.is_empty() || !shared.is_filter_generation_current(generation) {
        return true;
    }
    if let Ok(mut effects) = shared.effects.lock() {
        effects.process_interleaved(output);
    }
    let source_frames = tempo_source_frames(output.len(), speed);
    shared.push_output_samples_with_source_frames_for_filter_generation(
        output,
        source_frames,
        generation,
    )
}

fn tempo_source_frames(output_samples: usize, speed: f32) -> u64 {
    let output_frames = output_samples / TARGET_CHANNELS;
    ((output_frames as f64) * speed.clamp(crate::tempo::MIN_SPEED, crate::tempo::MAX_SPEED) as f64)
        .round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::DspSettings;
    use std::sync::atomic::Ordering;

    #[test]
    fn filter_thread_moves_decoded_samples_to_output_queue() {
        let shared = Arc::new(SharedAudio::new(100, 1.0, 8.0, &DspSettings::default()));
        shared.paused.store(false, Ordering::Release);
        let handle = spawn_filter_thread(shared.clone());
        let generation = shared.current_decode_generation();
        let samples = vec![0.1f32; 100];

        assert!(
            shared.push_decoded_samples_with_source_frames_for_generation(
                &samples,
                (samples.len() / TARGET_CHANNELS) as u64,
                generation,
            )
        );

        let mut output = [0.0f32; 4];
        for _ in 0..50 {
            if shared.pop_into(&mut output) > 0 {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        shared.request_stop();
        handle.join().expect("filter thread should exit cleanly");
        assert_eq!(output, [0.1, 0.1, 0.1, 0.1]);
    }
}
