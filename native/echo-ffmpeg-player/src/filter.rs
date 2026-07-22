use crate::audio_graph::AudioFilterGraph;
use crate::shared::{FilterInput, SharedAudio};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub fn spawn_filter_thread(shared: Arc<SharedAudio>) -> JoinHandle<()> {
    thread::Builder::new()
        .name("player-filter".to_string())
        .spawn(move || run_filter(shared))
        .expect("failed to spawn player filter thread")
}

fn run_filter(shared: Arc<SharedAudio>) {
    let mut generation = shared.current_filter_generation();
    let mut graph = match AudioFilterGraph::new(shared.mix_format, &shared.dsp_settings()) {
        Ok(graph) => graph,
        Err(err) => {
            shared.mark_decode_failed();
            crate::decoder::emit_decode_error(err);
            return;
        }
    };
    shared.set_filter_latency_secs(graph.latency_secs());
    let mut output = Vec::<f32>::new();

    loop {
        if shared.stop.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let current_generation = shared.current_filter_generation();
        if current_generation != generation {
            generation = current_generation;
            if let Err(err) = graph.reset(shared.mix_format, &shared.dsp_settings()) {
                shared.mark_decode_failed();
                crate::decoder::emit_decode_error(err);
                return;
            }
            shared.set_filter_latency_secs(graph.latency_secs());
            output.clear();
        }

        match shared.pop_decoded_for_filter(generation) {
            FilterInput::Frame(chunk) => {
                let settings = shared.dsp_settings();
                let source_frames = match graph.process_decoded(&chunk, &settings, &mut output) {
                    Ok(source_frames) => source_frames,
                    Err(err) => {
                        shared.mark_decode_failed();
                        crate::decoder::emit_decode_error(err);
                        return;
                    }
                };
                shared.set_filter_latency_secs(graph.latency_secs());
                push_filter_output(&shared, &mut output, source_frames, generation);
            }
            FilterInput::Boundary => {
                if let Err(err) = graph.reset(shared.mix_format, &shared.dsp_settings()) {
                    shared.mark_decode_failed();
                    crate::decoder::emit_decode_error(err);
                    return;
                }
                shared.set_filter_latency_secs(graph.latency_secs());
                output.clear();
            }
            FilterInput::Eof => {
                let settings = shared.dsp_settings();
                let source_frames = match graph.finish(&settings, &mut output) {
                    Ok(source_frames) => source_frames,
                    Err(err) => {
                        shared.mark_decode_failed();
                        crate::decoder::emit_decode_error(err);
                        return;
                    }
                };
                shared.set_filter_latency_secs(graph.latency_secs());
                push_filter_output(&shared, &mut output, source_frames, generation);
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
    source_frames: u64,
    generation: u64,
) -> bool {
    if output.is_empty() || !shared.is_filter_generation_current(generation) {
        return true;
    }
    shared.push_output_samples_with_source_frames_for_filter_generation(
        output,
        source_frames,
        generation,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::DspSettings;
    use crate::shared::{
        AudioSampleFormat, DecodedAudioChunk, DecodedAudioData, DecodedAudioFormat, MixFormat,
        MIX_CHANNELS,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn filter_thread_moves_decoded_samples_to_output_queue() {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(100),
            1.0,
            8.0,
            &DspSettings::default(),
        ));
        shared.paused.store(false, Ordering::Release);
        let handle = spawn_filter_thread(shared.clone());
        let generation = shared.current_decode_generation();
        let samples = vec![0.1f32; 200];
        let chunk = DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: shared.mix_format.sample_rate,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            samples.len() / MIX_CHANNELS,
            None,
            DecodedAudioData::F32(samples),
        );

        assert!(shared.push_decoded_chunk_for_generation(chunk, generation));

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
