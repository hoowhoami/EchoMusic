use super::*;
use std::sync::mpsc::{sync_channel, Receiver, TryRecvError};
use std::thread;
use std::time::Duration;

fn bind_test_signal_senders(shared: &SharedAudio) -> (Receiver<()>, Receiver<PlaybackSignal>) {
    let (control_tx, control_rx) = sync_channel(16);
    let (telemetry_tx, telemetry_rx) = sync_channel(16);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");
    (control_rx, telemetry_rx)
}

#[test]
fn audio_sample_format_candidates_prefer_lossless_conversions() {
    assert_eq!(
        AudioSampleFormat::F32.best_output_formats(),
        vec![
            AudioSampleFormat::F32,
            AudioSampleFormat::F64,
            AudioSampleFormat::S32,
            AudioSampleFormat::S16,
            AudioSampleFormat::U8,
        ]
    );
    assert_eq!(
        AudioSampleFormat::Unknown.best_output_formats(),
        vec![
            AudioSampleFormat::S16,
            AudioSampleFormat::S32,
            AudioSampleFormat::F32,
            AudioSampleFormat::F64,
            AudioSampleFormat::U8,
        ]
    );
}

#[test]
fn provider_descriptor_cache_survives_runtime_gain_but_invalidates_provider_changes() {
    let settings = DspSettings {
        provider_path: Some("provider.dylib".to_string()),
        provider_preset_json: Some(r#"{"presetId":"one"}"#.to_string()),
        ..DspSettings::default()
    };
    let shared = SharedAudio::new(MixFormat::stereo_f32(48_000), 0.1, 8.0, &settings);
    shared.set_provider_descriptor(Some(ProviderDescriptor {
        id: "provider".to_string(),
        ..ProviderDescriptor::default()
    }));

    let mut gain_update = settings.clone();
    gain_update.normalization_gain_db = -6.0;
    shared.update_dsp_settings(&gain_update);
    assert_eq!(
        shared.provider_descriptor().map(|descriptor| descriptor.id),
        Some("provider".to_string())
    );

    let mut preset_update = gain_update;
    preset_update.provider_preset_json = Some(r#"{"presetId":"two"}"#.to_string());
    shared.update_dsp_settings(&preset_update);
    assert!(shared.provider_descriptor().is_none());
}

#[test]
fn pop_into_advances_position_by_consumed_frames() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));

    let mut output = [1.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 4);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    assert!((shared.position_secs() - 0.04).abs() < f64::EPSILON);
}

#[test]
fn manual_track_boundary_fades_old_tail_out_and_new_head_in() {
    let mut samples = [1.0f32; 16];

    // Four stereo frames from the old track followed by four from the new track. A four-frame
    // envelope should approach zero on the old side and then rise monotonically on the new side.
    apply_track_boundary_fade(&mut samples, 8, 8, 2);

    let left: Vec<f32> = samples.chunks_exact(2).map(|frame| frame[0]).collect();
    assert_eq!(&left[..4], &[1.0, 0.75, 0.5, 0.25]);
    assert_eq!(&left[4..], &[0.25, 0.5, 0.75, 1.0]);
    assert!(samples
        .chunks_exact(2)
        .all(|frame| (frame[0] - frame[1]).abs() < f32::EPSILON));
}

#[test]
fn dsp_graph_boundary_envelope_survives_callback_boundaries() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(200),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[1.0; 8]));
    shared.mark_dsp_graph_boundary();
    assert!(shared.push_samples(&[1.0; 8]));

    let mut left = Vec::new();
    for _ in 0..8 {
        let mut frame = [0.0f32; 2];
        assert_eq!(shared.pop_into(&mut frame), 1);
        assert!((frame[0] - frame[1]).abs() < f32::EPSILON);
        left.push(frame[0]);
    }

    assert_eq!(left, vec![1.0, 1.0, 0.5, 0.0, 0.0, 0.5, 1.0, 1.0]);
}

#[test]
fn automatic_gapless_boundary_keeps_samples_bit_exact() {
    let mut samples = [0.75f32, -0.5, 0.25, -0.125];
    let original = samples;

    apply_track_boundary_fade(&mut samples, 2, 0, 2);

    assert_eq!(samples, original);
}

#[test]
fn queued_audio_keeps_source_clock_when_speed_changes() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples_with_source_frames(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], 4,));
    shared.set_speed(2.0);

    let mut output = [0.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 4);
    assert!((shared.position_secs() - 0.04).abs() < f64::EPSILON);
}

#[test]
fn position_reports_audible_clock_after_output_delay() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.update_output_stats(AudioOutputStats {
        backend: "test".to_string(),
        sample_rate: 100.0,
        engine_sample_rate: 100.0,
        channels: 2.0,
        format: "F32".to_string(),
        buffer_mode: "fixed(2)".to_string(),
        buffer_frames: 2.0,
        buffer_secs: 0.02,
        requested_buffer_secs: 0.02,
        device_buffer_secs: 0.02,
        software_buffer_secs: 0.0,
        ao_buffer_target_secs: 0.02,
        ao_buffer_capacity_secs: 2.0,
        ao_request_frames: 0.0,
        delay_secs: 0.02,
        underruns: 0.0,
    });
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));

    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);

    assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
}

#[test]
fn position_prefers_live_output_delay_over_static_estimate() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.update_output_stats(AudioOutputStats {
        backend: "test".to_string(),
        sample_rate: 100.0,
        engine_sample_rate: 100.0,
        channels: 2.0,
        format: "F32".to_string(),
        buffer_mode: "fixed(2)".to_string(),
        buffer_frames: 2.0,
        buffer_secs: 0.02,
        requested_buffer_secs: 0.02,
        device_buffer_secs: 0.02,
        software_buffer_secs: 0.0,
        ao_buffer_target_secs: 0.02,
        ao_buffer_capacity_secs: 2.0,
        ao_request_frames: 0.0,
        delay_secs: 0.02,
        underruns: 0.0,
    });
    shared.update_live_output_delay_secs(0.05);
    assert!(shared.push_samples(&[0.0; 20]));

    let mut output = [0.0f32; 20];
    assert_eq!(shared.pop_into(&mut output), 10);

    assert!((shared.position_secs() - 0.05).abs() < f64::EPSILON);
}

#[test]
fn position_scales_output_delay_by_speed() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.set_speed(2.0);
    shared.update_output_stats(AudioOutputStats {
        backend: "test".to_string(),
        sample_rate: 100.0,
        engine_sample_rate: 100.0,
        channels: 2.0,
        format: "F32".to_string(),
        buffer_mode: "fixed(2)".to_string(),
        buffer_frames: 2.0,
        buffer_secs: 0.02,
        requested_buffer_secs: 0.02,
        device_buffer_secs: 0.02,
        software_buffer_secs: 0.0,
        ao_buffer_target_secs: 0.02,
        ao_buffer_capacity_secs: 2.0,
        ao_request_frames: 0.0,
        delay_secs: 0.02,
        underruns: 0.0,
    });
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));

    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);

    assert!((shared.position_secs() - 0.04).abs() < f64::EPSILON);
}

#[test]
fn set_position_anchors_audible_clock_after_delay_and_filter_latency() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.update_output_stats(AudioOutputStats {
        backend: "test".to_string(),
        sample_rate: 100.0,
        engine_sample_rate: 100.0,
        channels: 2.0,
        format: "F32".to_string(),
        buffer_mode: "fixed(3)".to_string(),
        buffer_frames: 3.0,
        buffer_secs: 0.03,
        requested_buffer_secs: 0.03,
        device_buffer_secs: 0.03,
        software_buffer_secs: 0.0,
        ao_buffer_target_secs: 0.03,
        ao_buffer_capacity_secs: 2.0,
        ao_request_frames: 0.0,
        delay_secs: 0.03,
        underruns: 0.0,
    });
    shared.set_filter_latency_secs(0.02);

    shared.set_position_secs(1.25);

    assert!((shared.position_secs() - 1.25).abs() < f64::EPSILON);
    assert_eq!(shared.played_sample_count(), 130);
}

#[test]
fn set_position_scales_delay_anchor_by_speed() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.set_speed(2.0);
    shared.update_output_stats(AudioOutputStats {
        backend: "test".to_string(),
        sample_rate: 100.0,
        engine_sample_rate: 100.0,
        channels: 2.0,
        format: "F32".to_string(),
        buffer_mode: "fixed(3)".to_string(),
        buffer_frames: 3.0,
        buffer_secs: 0.03,
        requested_buffer_secs: 0.03,
        device_buffer_secs: 0.03,
        software_buffer_secs: 0.0,
        ao_buffer_target_secs: 0.03,
        ao_buffer_capacity_secs: 2.0,
        ao_request_frames: 0.0,
        delay_secs: 0.03,
        underruns: 0.0,
    });
    shared.set_filter_latency_secs(0.02);

    shared.set_position_secs(1.25);

    assert!((shared.position_secs() - 1.25).abs() < f64::EPSILON);
    assert_eq!(shared.played_sample_count(), 135);
}

#[test]
fn playback_restart_is_emitted_when_restart_audio_is_ready() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    let (wake_rx, _telemetry_rx) = bind_test_signal_senders(&shared);
    shared.mark_playback_restart_ready(1.0);

    assert_eq!(wake_rx.try_recv(), Ok(()));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackRestart(position)) if (position - 1.0).abs() < f64::EPSILON
    ));
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    let mut output = [0.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 2);
}

#[test]
fn pop_into_short_non_eof_buffer_enters_output_underrun() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));

    let mut output = [1.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 2);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.0, 0.0, 0.0, 0.0]);
    assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
    assert!(shared.ao_state.ao_underrun());
}

#[test]
fn pop_into_does_not_touch_wait_queue_lock() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    let _queue = shared.output_queue_wait.lock().expect("queue lock");

    let mut output = [1.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 2);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4]);
    assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
}

#[test]
fn eof_is_reported_only_after_buffer_is_drained() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2]));

    shared.mark_eof();
    assert!(!shared.is_drained());

    let mut output = [0.0f32; 2];
    shared.pop_into(&mut output);

    assert!(shared.is_drained());
    assert!(shared.mark_end_reported());
    assert!(!shared.mark_end_reported());
}

#[test]
fn output_drain_check_does_not_touch_wait_queue_lock() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.mark_eof();
    let _queue = shared.output_queue_wait.lock().expect("queue lock");

    assert!(shared.is_drained_for_output());
}

#[test]
fn reset_for_decode_resume_clears_buffer_and_sets_position() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    shared.mark_eof();

    shared.reset_for_decode_resume(1.25, &DspSettings::default());

    let mut output = [1.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 4]);
    assert!((shared.position_secs() - 1.25).abs() < f64::EPSILON);
    assert!(!shared.is_drained());
    assert!(shared.mark_end_reported());
}

#[test]
fn reset_for_decode_resume_waits_for_resume_threshold() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        8.0,
        &DspSettings::default(),
    );
    shared.reset_for_decode_resume(1.0, &DspSettings::default());
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));

    let mut output = [1.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 0);
    assert_eq!(output, [0.0; 8]);
    assert!((shared.position_secs() - 1.0).abs() < f64::EPSILON);
}

#[test]
fn decoded_eof_drains_output_below_resume_threshold() {
    let settings = DspSettings::default();
    let shared = SharedAudio::with_output_buffer(MixFormat::stereo_f32(100), 0.2, 8.0, &settings);
    shared.reset_for_decode_resume(10.0, &settings);
    assert!(shared.push_samples(&[0.25; 8]));

    let mut held = [1.0; 8];
    assert_eq!(shared.pop_into(&mut held), 0);
    assert_eq!(held, [0.0; 8]);

    shared.mark_decoded_eof();
    let mut drained = [0.0; 16];
    assert_eq!(shared.pop_into(&mut drained), 4);
    assert_eq!(&drained[..8], &[0.25; 8]);
    assert_eq!(&drained[8..], &[0.0; 8]);
    assert_eq!(shared.output_underrun_count(), 0);
}

#[test]
fn ao_preroll_waits_for_realtime_queue() {
    let shared = SharedAudio::with_output_buffer(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.reset_for_decode_resume(1.0, &DspSettings::default());
    assert!(shared.push_samples(&[0.25; 8]));

    let mut output = [1.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 0);
    assert_eq!(output, [0.0; 8]);
    assert!(shared.ao_state.is_buffering());
}

#[test]
fn output_underrun_recovery_uses_observed_demand_target() {
    let shared = SharedAudio::with_output_buffer(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    shared.ao_state.reset();
    assert!(shared.push_samples(&[0.25; 4]));

    let mut output = [1.0f32; 8];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 2);
    assert_eq!(output, [0.25, 0.25, 0.25, 0.25, 0.0, 0.0, 0.0, 0.0]);
    assert!(shared.ao_state.ao_underrun());

    assert_eq!(shared.output_buffer_target_samples(), 20);
    assert!(shared.push_samples(&[0.25; 20]));
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, [0.25; 8]);
}

#[test]
fn reset_for_decode_resume_publishes_buffering_progress_when_audio_arrives() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        8.0,
        &DspSettings::default(),
    );
    let (control_rx, _telemetry_rx) = bind_test_signal_senders(&shared);
    shared.reset_for_decode_resume(1.0, &DspSettings::default());

    let mut output = [1.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(control_rx.try_recv(), Ok(()));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::AoState { paused: true, .. })
    ));

    assert!(shared.push_samples(&[0.1; 20]));
    assert_eq!(control_rx.try_recv(), Ok(()));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::AoState { paused: true, .. })
    ));
}

#[test]
fn signal_sender_rejects_duplicate_binding() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (first_control, _first_control_rx) = sync_channel(1);
    let (first_telemetry, _first_telemetry_rx) = sync_channel(1);
    let (second_control, _second_control_rx) = sync_channel(1);
    let (second_telemetry, _second_telemetry_rx) = sync_channel(1);

    assert!(shared
        .bind_signal_senders(first_control, first_telemetry)
        .is_ok());
    assert_eq!(
        shared.bind_signal_senders(second_control, second_telemetry),
        Err("playback signal sender is already bound"),
    );
}

#[test]
fn control_signal_is_not_blocked_by_full_telemetry_queue() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (control_tx, control_rx) = sync_channel(1);
    let (telemetry_tx, _telemetry_rx) = sync_channel(1);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");

    shared.update_packet_cache_stats(PacketCacheStats::default());
    let mut changed = PacketCacheStats::default();
    changed.eof = true;
    shared.update_packet_cache_stats(changed);
    shared.notify_playback_end();

    assert_eq!(control_rx.try_recv(), Ok(()));
    assert_eq!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackEnd)
    );
}

#[test]
fn latest_ao_state_is_not_dropped_or_reordered_by_full_telemetry_queue() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (control_tx, control_rx) = sync_channel(1);
    let (telemetry_tx, _telemetry_rx) = sync_channel(1);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");

    shared.notify_ao_state(true, "preroll", 95.0, 0.19, 0.2);
    shared.notify_ao_state(false, "preroll", 100.0, 0.2, 0.2);

    assert_eq!(control_rx.try_recv(), Ok(()));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::AoState { paused: false, .. })
    ));
}

#[test]
fn ao_state_writer_contention_preserves_the_inflight_snapshot() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );

    // Model one publisher after it has claimed the odd sequence but before it
    // commits. A second publisher must not make the sequence even or overwrite
    // any part of that in-flight snapshot.
    let sequence = shared.pending_ao_state_sequence.load(Ordering::Acquire);
    shared
        .pending_ao_state_sequence
        .compare_exchange(
            sequence,
            sequence.wrapping_add(1),
            Ordering::AcqRel,
            Ordering::Acquire,
        )
        .unwrap();
    shared
        .pending_ao_state_paused
        .store(true, Ordering::Relaxed);
    shared
        .pending_ao_state_reason_is_underrun
        .store(false, Ordering::Relaxed);
    shared
        .pending_ao_state_buffering_state_bits
        .store(95.0_f64.to_bits(), Ordering::Relaxed);
    shared
        .pending_ao_state_buffered_secs_bits
        .store(0.19_f64.to_bits(), Ordering::Relaxed);
    shared
        .pending_ao_state_target_secs_bits
        .store(0.2_f64.to_bits(), Ordering::Relaxed);

    shared.notify_ao_state(false, "underrun", 100.0, 9.0, 8.0);

    assert_eq!(
        shared.pending_ao_state_sequence.load(Ordering::Acquire),
        sequence.wrapping_add(1)
    );
    assert!(shared.pending_ao_state_paused.load(Ordering::Relaxed));
    assert!(!shared
        .pending_ao_state_reason_is_underrun
        .load(Ordering::Relaxed));
    assert_eq!(
        shared
            .pending_ao_state_buffering_state_bits
            .load(Ordering::Relaxed),
        95.0_f64.to_bits()
    );

    shared
        .pending_ao_state_sequence
        .store(sequence.wrapping_add(2), Ordering::Release);
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::AoState {
            paused: true,
            reason: "preroll",
            buffering_state,
            buffered_secs,
            target_secs,
        }) if buffering_state == 95.0 && buffered_secs == 0.19 && target_secs == 0.2
    ));
}

#[test]
fn full_control_wake_queue_coalesces_without_losing_pending_signals() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (control_tx, control_rx) = sync_channel(1);
    let (telemetry_tx, _telemetry_rx) = sync_channel(1);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");

    shared.notify_playback_restart(1.0);
    shared.notify_playback_end();

    assert_eq!(control_rx.try_recv(), Ok(()));
    assert_eq!(control_rx.try_recv(), Err(TryRecvError::Empty));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackRestart(position)) if (position - 1.0).abs() < f64::EPSILON
    ));
    assert_eq!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackEnd)
    );
    assert_eq!(shared.take_pending_control_signal(), None);
}

#[test]
fn repeated_restart_notifications_coalesce_to_the_latest_position() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (control_tx, _control_rx) = sync_channel(1);
    let (telemetry_tx, _telemetry_rx) = sync_channel(1);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");

    shared.notify_playback_restart(1.0);
    shared.notify_playback_restart(2.5);

    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackRestart(position)) if (position - 2.5).abs() < f64::EPSILON
    ));
    assert_eq!(shared.take_pending_control_signal(), None);
}

#[test]
fn stop_is_observed_even_when_the_wake_channel_is_already_full() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let (control_tx, control_rx) = sync_channel(1);
    let (telemetry_tx, _telemetry_rx) = sync_channel(1);
    shared
        .bind_signal_senders(control_tx, telemetry_tx)
        .expect("signal senders should bind once");

    shared.notify_playback_restart(1.0);
    shared.request_stop();

    // This is the original restart token: request_stop cannot enqueue another
    // one into the full wake channel. The pending mailbox assertion below is
    // what proves that Stop still supersedes the earlier notification.
    assert_eq!(control_rx.try_recv(), Ok(()));
    assert_eq!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::Stop)
    );
}

#[test]
fn repeated_preroll_callbacks_do_not_count_as_underruns() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        1.0,
        &DspSettings::default(),
    );
    shared.reset_for_decode_resume(1.0, &DspSettings::default());

    let mut output = [1.0f32; 4];
    for _ in 0..20 {
        assert_eq!(shared.pop_into(&mut output), 0);
    }

    assert_eq!(shared.output_underrun_count(), 0);
    assert_eq!(shared.output_buffer_target_samples(), 20);
}

#[test]
fn dsp_filter_reset_keeps_decoded_queue_available() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        8.0,
        &DspSettings::default(),
    );
    let generation = shared.current_decode_generation();
    let chunk = DecodedAudioChunk::new(
        DecodedAudioFormat {
            sample_rate: shared.mix_format.sample_rate,
            sample_format: AudioSampleFormat::F32,
            channels: MIX_CHANNELS,
        },
        2,
        None,
        DecodedAudioData::F32(vec![0.1, 0.2, 0.3, 0.4]),
    );
    assert!(shared.push_decoded_chunk_for_generation(chunk.clone(), generation));
    let mut settings = DspSettings::default();
    settings.speed = 2.0;
    shared.reset_filter_for_dsp_change(&settings);

    assert_eq!(
        shared.pop_decoded_for_filter(shared.current_filter_generation(),),
        FilterInput::Frame(chunk)
    );
}

#[test]
fn dsp_filter_reset_keeps_ready_output_available() {
    let mut settings = DspSettings::default();
    let shared = SharedAudio::new(MixFormat::stereo_f32(100), 0.1, 8.0, &settings);
    let ready = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    assert!(shared.push_samples(&ready));

    settings.speed = 1.25;
    shared.reset_filter_for_dsp_change(&settings);

    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, ready);
}

#[test]
fn dsp_filter_reset_does_not_abort_an_inflight_output_chunk() {
    let settings = DspSettings::default();
    let shared = Arc::new(SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &settings,
    ));
    let target_samples = shared.output_buffer_target_samples();
    let samples = (0..target_samples * 4)
        .map(|index| index as f32 / (target_samples * 8) as f32)
        .collect::<Vec<_>>();
    let source_frames = (samples.len() / MIX_CHANNELS) as u64;
    let generation = shared.current_decode_generation();
    let producer_shared = shared.clone();
    let producer_samples = samples.clone();
    let producer = thread::spawn(move || {
        producer_shared.push_output_samples_with_source_frames_for_decode_generation(
            &producer_samples,
            source_frames,
            generation,
        )
    });

    for _ in 0..100 {
        if shared.realtime_output.buffered_samples() >= target_samples {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(shared.realtime_output.buffered_samples(), target_samples);

    shared.reset_filter_for_dsp_change(&settings);

    let mut collected = Vec::with_capacity(samples.len());
    let mut output = [0.0f32; 8];
    for _ in 0..200 {
        let frames = shared.pop_into(&mut output);
        collected.extend_from_slice(&output[..frames * MIX_CHANNELS]);
        if collected.len() == samples.len() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }

    assert!(producer.join().expect("producer should exit cleanly"));
    assert_eq!(collected, samples);
}

#[test]
fn decode_reset_aborts_and_clears_an_inflight_old_output_chunk() {
    let settings = DspSettings::default();
    let shared = Arc::new(SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &settings,
    ));
    let target_samples = shared.output_buffer_target_samples();
    let samples = vec![0.25f32; target_samples * 4];
    let generation = shared.current_decode_generation();
    let producer_shared = shared.clone();
    let producer = thread::spawn(move || {
        producer_shared.push_output_samples_with_source_frames_for_decode_generation(
            &samples,
            (target_samples * 2) as u64,
            generation,
        )
    });

    for _ in 0..100 {
        if shared.realtime_output.buffered_samples() >= target_samples {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(shared.realtime_output.buffered_samples(), target_samples);

    shared.reset_for_decode_resume(5.0, &settings);

    assert!(!producer.join().expect("stale producer should exit cleanly"));
    assert_eq!(shared.realtime_output.buffered_samples(), 0);
    let mut output = [1.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 8]);
    assert!((shared.position_secs() - 5.0).abs() < f64::EPSILON);
}

#[test]
fn staged_audio_effect_graph_keeps_ready_output_available() {
    let settings = DspSettings::default();
    let shared = SharedAudio::new(MixFormat::stereo_f32(100), 0.1, 8.0, &settings);
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    let graph = crate::audio_graph::AudioFilterGraph::new(shared.mix_format, &settings)
        .expect("default graph should initialize");

    shared.stage_audio_effect_graph(&settings, graph, true);

    let (_, prefer_in_place) = shared
        .take_staged_filter_graph(shared.current_filter_generation())
        .expect("staged graph should be available");
    assert!(prefer_in_place);
    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
}

#[test]
fn staged_audio_effect_graph_survives_a_later_speed_generation() {
    let mut settings = DspSettings::default();
    let shared = SharedAudio::new(MixFormat::stereo_f32(100), 0.1, 8.0, &settings);
    let graph = crate::audio_graph::AudioFilterGraph::new(shared.mix_format, &settings)
        .expect("default graph should initialize");

    let previous_generation = shared.current_filter_generation();
    shared.stage_audio_effect_graph(&settings, graph, false);
    settings.speed = 1.75;
    shared.reset_filter_for_dsp_change(&settings);

    let update = shared
        .take_filter_graph_update(previous_generation)
        .expect("combined graph and speed update should be visible");
    assert_eq!(update.filter_generation, shared.current_filter_generation());
    assert!((update.settings.speed - 1.75).abs() < f32::EPSILON);
    assert!(update.staged_graph.is_some());
}

#[test]
fn gapless_filter_boundary_keeps_decoded_order() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        8.0,
        &DspSettings::default(),
    );
    let generation = shared.current_decode_generation();
    let first = DecodedAudioChunk::new(
        DecodedAudioFormat {
            sample_rate: 100,
            sample_format: AudioSampleFormat::F32,
            channels: MIX_CHANNELS,
        },
        1,
        None,
        DecodedAudioData::F32(vec![0.1, 0.2]),
    );
    let second = DecodedAudioChunk::new(
        DecodedAudioFormat {
            sample_rate: 100,
            sample_format: AudioSampleFormat::F32,
            channels: MIX_CHANNELS,
        },
        1,
        None,
        DecodedAudioData::F32(vec![0.3, 0.4]),
    );

    assert!(shared.push_decoded_chunk_for_generation(first.clone(), generation));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 8,
        duration: 2.0,
    });
    assert!(shared.push_decoded_chunk_for_generation(second.clone(), generation));

    assert_eq!(
        shared.pop_decoded_for_filter(shared.current_filter_generation()),
        FilterInput::Frame(first)
    );
    assert_eq!(
        shared.pop_decoded_for_filter(shared.current_filter_generation()),
        FilterInput::Boundary
    );
    assert_eq!(
        shared.pop_decoded_for_filter(shared.current_filter_generation()),
        FilterInput::Frame(second)
    );
}

#[test]
fn gapless_boundary_resets_position_after_crossing_track_switch() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    let (wake_rx, _telemetry_rx) = bind_test_signal_senders(&shared);
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 7,
        duration: 3.0,
    });
    assert!(shared.push_samples(&[0.5, 0.6, 0.7, 0.8]));
    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
    assert_eq!(shared.output_underrun_count(), 0);

    assert_eq!(wake_rx.try_recv(), Ok(()));
    match shared.take_pending_control_signal() {
        Some(PlaybackSignal::TrackSwitch(info)) => {
            assert_eq!(info.url, "next.flac");
            assert_eq!(info.seq, 7);
        }
        other => panic!("expected track switch signal, got {other:?}"),
    }
}

#[test]
fn busy_track_switch_mailbox_stalls_without_consuming_the_boundary() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    let (wake_rx, _telemetry_rx) = bind_test_signal_senders(&shared);
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 7,
        duration: 3.0,
    });
    assert!(shared.push_samples(&[0.5, 0.6, 0.7, 0.8]));
    // Fill the one-slot wake channel first. The later TrackSwitch must remain in its
    // semantic mailbox even though its wake token is coalesced.
    shared.notify_playback_restart(1.0);

    let mailbox_guard = shared
        .pending_track_switch
        .lock()
        .expect("test mailbox should lock");
    let mut blocked_output = [1.0f32; 8];
    assert_eq!(shared.pop_into(&mut blocked_output), 0);
    assert_eq!(blocked_output, [0.0; 8]);
    assert_eq!(shared.played_sample_count(), 0);
    drop(mailbox_guard);

    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    assert_eq!(wake_rx.try_recv(), Ok(()));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::TrackSwitch(TrackSwitchInfo { seq: 7, .. }))
    ));
    assert!(matches!(
        shared.take_pending_control_signal(),
        Some(PlaybackSignal::PlaybackRestart(position)) if (position - 1.0).abs() < f64::EPSILON
    ));
}

#[test]
fn gapless_boundary_keeps_advancing_the_ao_clock() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    let (_control_rx, _telemetry_rx) = bind_test_signal_senders(&shared);
    assert!(shared.push_samples(&[0.1; 4]));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 7,
        duration: 3.0,
    });
    assert!(shared.push_samples(&[0.2; 4]));

    let mut boundary_output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut boundary_output), 4);
    let boundary_position = shared.position_secs();
    assert_eq!(shared.current_track_seq(), 7);

    assert!(shared.push_samples(&[0.3; 20]));
    let mut next_output = [0.0f32; 20];
    assert_eq!(shared.pop_into(&mut next_output), 10);
    assert!(shared.position_secs() > boundary_position);
}

#[test]
fn gapless_boundary_resets_underrun_counter() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        1.0,
        &DspSettings::default(),
    );
    for _ in 0..20 {
        shared.record_output_underrun();
    }
    shared.observe_output_request(240);
    assert_eq!(shared.output_buffer_target_samples(), 240);
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 7,
        duration: 3.0,
    });
    assert!(shared.push_samples(&[0.5, 0.6, 0.7, 0.8]));

    let mut output = [0.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 4);

    assert_eq!(shared.output_underrun_count(), 0);
    assert_eq!(shared.output_buffer_target_samples(), 20);
    assert_eq!(shared.max_output_request_frames(), 0);
}

#[test]
fn gapless_boundary_short_read_keeps_new_track_in_underrun_hold() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        1.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
    shared.mark_gapless_boundary(TrackSwitchInfo {
        url: "next.flac".to_string(),
        audio_stream_ordinal: None,
        seq: 7,
        duration: 3.0,
    });
    assert!(shared.push_samples(&[0.5, 0.6]));

    let mut output = [0.0f32; 40];
    assert_eq!(shared.pop_into(&mut output), 3);

    assert_eq!(shared.current_track_seq(), 7);
    assert_eq!(shared.output_underrun_count(), 1);
    assert!(shared.ao_state.ao_underrun());
    assert_eq!(shared.output_buffer_target_samples(), 40);
}

#[test]
fn stall_timeout_can_be_disabled_and_clamped() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.1,
        8.0,
        &DspSettings::default(),
    );
    assert_eq!(shared.stall_timeout(), Duration::from_secs(8));

    shared.set_stall_timeout(0.0);
    assert_eq!(shared.stall_timeout(), Duration::ZERO);

    shared.set_stall_timeout(120.0);
    assert_eq!(shared.stall_timeout(), Duration::from_secs(60));
}

#[test]
fn output_ring_keeps_headroom_separate_from_configured_target() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );

    assert_eq!(shared.configured_output_buffer_samples, 40);
    assert_eq!(shared.output_buffer_target_samples(), 40);
    assert_eq!(shared.output_ring_capacity, 400);
    assert_eq!(shared.decoded_queue_capacity_frames, 20);
}

#[test]
fn stale_gapless_prepare_completion_does_not_clear_new_request() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    let stale_epoch = shared.begin_gapless_prepare();
    shared.clear_gapless_prepares();
    let current_epoch = shared.begin_gapless_prepare();

    shared.finish_gapless_prepare(stale_epoch);
    assert!(shared.gapless_prepare_is_pending());

    shared.finish_gapless_prepare(current_epoch);
    assert!(!shared.gapless_prepare_is_pending());
}

#[test]
fn gapless_prepare_request_suspends_stall_watch_until_completed() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    shared.mark_output_started();
    shared.paused.store(false, Ordering::Release);
    assert!(shared.should_watch_for_stall());

    let request_id = shared.begin_gapless_prepare();
    assert!(!shared.should_watch_for_stall());
    assert!(!shared.cancel_gapless_prepare(request_id.wrapping_add(1)));
    assert!(shared.cancel_gapless_prepare(request_id));
    assert!(shared.should_watch_for_stall());
}

#[test]
fn output_ring_honors_larger_audio_buffer_setting() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        8.0,
        &DspSettings::default(),
    );

    assert_eq!(shared.configured_output_buffer_samples, 400);
    assert_eq!(shared.output_buffer_target_samples(), 400);
    assert_eq!(shared.output_ring_capacity, 400);
    assert_eq!(shared.decoded_queue_capacity_frames, 200);
}

#[test]
fn oversized_output_request_grows_target_before_consuming_audio() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    shared.begin_output_preroll();
    assert!(shared.push_samples(&vec![0.5; 40]));

    let mut output = [1.0f32; 80];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 80]);
    assert_eq!(shared.output_buffer_target_samples(), 80);
    assert_eq!(shared.max_output_request_frames(), 40);

    assert!(shared.push_samples(&vec![0.5; 40]));
    assert_eq!(shared.pop_into(&mut output), 40);
    assert_eq!(output, [0.5; 80]);
    assert_eq!(shared.output_underrun_count(), 0);
    assert!(!shared.ao_state.ao_underrun());
}

#[test]
fn oversized_output_request_can_drain_at_eof() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&vec![0.5; 40]));
    shared.mark_eof();

    let mut output = [1.0f32; 80];
    let frames = shared.pop_into(&mut output);

    assert_eq!(frames, 20);
    assert_eq!(&output[..40], &[0.5; 40]);
    assert_eq!(&output[40..], &[0.0; 40]);
    assert_eq!(shared.output_underrun_count(), 0);
}

#[test]
fn ao_resume_ignores_decoded_readahead() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&vec![0.1; 40]));
    assert!(shared.push_decoded_chunk_for_generation(
        DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 100,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            80,
            None,
            DecodedAudioData::F32(vec![0.2; 160]),
        ),
        shared.current_decode_generation(),
    ));
    shared.ao_state.set_ao_underrun(true);

    let mut output = [0.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 2);
    assert_eq!(output, [0.1; 4]);
    assert!(!shared.ao_state.ao_underrun());
}

#[test]
fn output_underrun_waits_for_realtime_output_even_with_decoded_readahead() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_decoded_chunk_for_generation(
        DecodedAudioChunk::new(
            DecodedAudioFormat {
                sample_rate: 100,
                sample_format: AudioSampleFormat::F32,
                channels: MIX_CHANNELS,
            },
            100,
            None,
            DecodedAudioData::F32(vec![0.2; 200]),
        ),
        shared.current_decode_generation(),
    ));
    shared.ao_state.set_ao_underrun(true);

    let mut output = [0.0f32; 4];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 4]);
    assert!(shared.ao_state.ao_underrun());

    assert!(shared.push_samples(&[0.1; 4]));
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 4]);
    assert!(shared.ao_state.ao_underrun());

    assert!(shared.push_samples(&[0.1; 36]));
    assert_eq!(shared.pop_into(&mut output), 2);
    assert_eq!(output, [0.1; 4]);
    assert!(!shared.ao_state.ao_underrun());
}

#[test]
fn output_underrun_adds_callback_burst_headroom() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        8.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&[0.1; 20]));

    let mut output = [0.0f32; 40];
    assert_eq!(shared.pop_into(&mut output), 10);
    assert!(shared.ao_state.ao_underrun());
    assert_eq!(shared.output_buffer_target_samples(), 80);

    assert!(shared.push_samples(&[0.1; 80]));
    assert_eq!(shared.pop_into(&mut output), 20);
    assert_eq!(shared.pop_into(&mut output), 20);
    assert!(shared.push_samples(&[0.1; 20]));
    assert_eq!(shared.pop_into(&mut output), 10);
    assert_eq!(shared.output_buffer_target_samples(), 80);
}

#[test]
fn underrun_counter_alone_does_not_change_ao_target() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        2.0,
        1.0,
        &DspSettings::default(),
    );

    assert_eq!(shared.output_buffer_target_samples(), 400);
    for _ in 0..5 {
        shared.record_output_underrun();
    }
    assert_eq!(shared.output_buffer_target_samples(), 400);
    for _ in 5..20 {
        shared.record_output_underrun();
    }
    assert_eq!(shared.output_buffer_target_samples(), 400);
}

#[test]
fn decode_resume_resets_adaptive_callback_target() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        1.0,
        &DspSettings::default(),
    );
    let mut output = vec![0.0; 240];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(shared.output_buffer_target_samples(), 400);
    assert_eq!(shared.output_underrun_count(), 1);

    shared.reset_for_decode_resume(12.0, &DspSettings::default());

    assert_eq!(shared.output_underrun_count(), 0);
    assert_eq!(shared.output_buffer_target_samples(), 40);
    assert_eq!(shared.max_output_request_frames(), 0);
}

#[test]
fn decode_resume_keeps_current_device_buffer_as_target_floor() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        1.0,
        &DspSettings::default(),
    );
    shared.register_output_device_buffer(30, 100);
    assert_eq!(shared.output_buffer_target_samples(), 60);
    shared.observe_output_request(240);
    assert_eq!(shared.output_buffer_target_samples(), 240);

    shared.reset_for_decode_resume(12.0, &DspSettings::default());

    assert_eq!(shared.output_buffer_target_samples(), 60);
    assert_eq!(shared.max_output_request_frames(), 0);
}

#[test]
fn output_restart_discards_previous_device_and_adaptive_targets() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        1.0,
        &DspSettings::default(),
    );
    shared.register_output_device_buffer(80, 100);
    shared.observe_output_request(240);
    assert_eq!(shared.output_buffer_target_samples(), 240);

    shared.prepare_output_start();

    assert_eq!(shared.output_buffer_target_samples(), 40);
    assert_eq!(shared.max_output_request_frames(), 0);

    shared.register_output_device_buffer(30, 100);
    assert_eq!(shared.output_buffer_target_samples(), 60);
}

#[test]
fn output_restart_prerolls_when_new_device_has_a_larger_buffer() {
    let shared = SharedAudio::new(
        MixFormat::stereo_f32(100),
        0.2,
        1.0,
        &DspSettings::default(),
    );
    assert!(shared.push_samples(&vec![0.5; 40]));

    shared.prepare_output_start();
    shared.register_output_device_buffer(30, 100);
    assert_eq!(shared.output_buffer_target_samples(), 60);

    let mut output = [1.0f32; 8];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 8]);
    assert!(shared.ao_state.is_buffering());

    assert!(shared.push_samples(&vec![0.5; 20]));
    assert_eq!(shared.pop_into(&mut output), 4);
    assert_eq!(output, [0.5; 8]);
    assert!(!shared.ao_state.is_buffering());
}
