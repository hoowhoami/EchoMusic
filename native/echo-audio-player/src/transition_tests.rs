//! End-to-end tests for song transitions: two synthetic WAV files run through the real
//! decode worker, filter thread and `SharedAudio` output ring (no audio device).

use super::*;
use crate::control::{
    armed_transition_from_prepared, plan_prepared_transition, PreparedTransitionInputs,
};
use crate::decoder::{spawn_decode_worker, DecodeCommand, DecoderData};
use crate::dsp::DspSettings;
use crate::filter::spawn_filter_thread;
use crate::shared::{MixFormat, PlaybackSignal, SharedAudio, TrackSwitchInfo};
use crate::transition::{TransitionMode, TransitionSettings};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

static TEST_FILE_ID: AtomicU64 = AtomicU64::new(0);
const SR: u32 = 44_100;

struct TestWav(std::path::PathBuf);

impl TestWav {
    /// Stereo 16-bit WAV with `secs` seconds of a tone, optional leading/trailing silence
    /// and a kick on every beat at `bpm` (so the analyzer finds a grid).
    fn new(secs: f64, tone_hz: f32, bpm: f32, lead_silence: f64, tail_silence: f64) -> Self {
        let frames = (secs * f64::from(SR)) as usize;
        let beat = 60.0 / f64::from(bpm);
        let mut samples = Vec::with_capacity(frames * 2);
        for frame in 0..frames {
            let t = frame as f64 / f64::from(SR);
            let mut value = 0.0f32;
            if t >= lead_silence && t < secs - tail_silence {
                value =
                    (2.0 * std::f32::consts::PI * tone_hz * frame as f32 / SR as f32).sin() * 0.25;
                let beat_pos = ((t - lead_silence) / beat).fract() * beat;
                if beat_pos < 0.05 {
                    let env = (-(beat_pos as f32) / 0.01).exp();
                    let beat_index = ((t - lead_silence) / beat) as usize;
                    let accent = if beat_index % 4 == 0 { 0.6 } else { 0.3 };
                    value +=
                        accent * env * (2.0 * std::f32::consts::PI * 60.0 * beat_pos as f32).sin();
                }
            }
            let sample = (value.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            samples.push(sample);
            samples.push(sample);
        }
        let mut wav = Vec::with_capacity(44 + samples.len() * 2);
        let data_len = (samples.len() * 2) as u32;
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_len).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&SR.to_le_bytes());
        wav.extend_from_slice(&(SR * 4).to_le_bytes());
        wav.extend_from_slice(&4u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_len.to_le_bytes());
        for sample in samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }
        let path = std::env::temp_dir().join(format!(
            "echo-transition-{}-{}.wav",
            std::process::id(),
            TEST_FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::write(&path, wav).expect("write WAV fixture");
        Self(path)
    }

    fn url(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TestWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn open(url: &str) -> DecoderData {
    DecoderData::open(
        url.to_string(),
        None,
        Some(SR),
        Arc::new(AtomicBool::new(false)),
        ffmpeg_audio::PacketCacheOptions::default(),
        &crate::stream::StreamOptions::default(),
    )
    .expect("open test wav")
}

struct Rig {
    shared: Arc<SharedAudio>,
    commands: SyncSender<DecodeCommand>,
    control_rx: Receiver<()>,
    _telemetry_rx: Receiver<PlaybackSignal>,
    decode_thread: Option<std::thread::JoinHandle<Option<DecoderData>>>,
    filter_thread: Option<std::thread::JoinHandle<()>>,
}

impl Rig {
    fn start(a_url: &str) -> Self {
        let shared = Arc::new(SharedAudio::new(
            MixFormat::stereo_f32(SR),
            0.5,
            8.0,
            &DspSettings::default(),
        ));
        let (control_tx, control_rx) = sync_channel(64);
        let (telemetry_tx, telemetry_rx) = sync_channel(64);
        shared
            .bind_signal_senders(control_tx, telemetry_tx)
            .expect("bind");
        shared.paused.store(false, Ordering::Release);
        shared.set_track_seq(1);
        let filter_thread = spawn_filter_thread(shared.clone());
        let decoder = open(a_url);
        let generation = shared.current_decode_generation();
        let (decode_thread, commands) =
            spawn_decode_worker(decoder, shared.clone(), generation).expect("spawn worker");
        Self {
            shared,
            commands,
            control_rx,
            _telemetry_rx: telemetry_rx,
            decode_thread: Some(decode_thread),
            filter_thread: Some(filter_thread),
        }
    }

    /// Pull everything through the output ring until EOF; records the track-switch signal.
    fn drain(&mut self, max_secs: f64) -> (Vec<f32>, Option<(TrackSwitchInfo, usize)>) {
        let mut out = Vec::new();
        let mut buffer = vec![0.0f32; 1_024];
        let mut switch = None;
        let started = Instant::now();
        let max_samples = (max_secs * f64::from(SR)) as usize * 2;
        loop {
            let frames = self.shared.pop_into(&mut buffer);
            if frames > 0 {
                out.extend_from_slice(&buffer[..frames * 2]);
            } else if self.shared.is_drained_for_output() {
                break;
            } else {
                std::thread::sleep(Duration::from_millis(1));
            }
            if switch.is_none() {
                while let Ok(()) = self.control_rx.try_recv() {}
                if let Some(PlaybackSignal::TrackSwitch(info)) =
                    self.shared.take_pending_control_signal()
                {
                    switch = Some((info, out.len()));
                }
            }
            if out.len() >= max_samples || started.elapsed() > Duration::from_secs(60) {
                break;
            }
        }
        (out, switch)
    }

    fn stop(mut self) {
        self.shared.request_stop();
        let _ = self.commands.send(DecodeCommand::Stop);
        if let Some(handle) = self.decode_thread.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.filter_thread.take() {
            let _ = handle.join();
        }
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn set_mode(mode: TransitionMode, fade_secs: f32) {
    let mut settings = crate::control::transition::TRANSITION_SETTINGS
        .lock()
        .expect("settings");
    *settings = TransitionSettings { mode, fade_secs };
}

/// Prepare B exactly like `PrepareNextSourceTask` does and arm it on the worker.
fn prepare_and_arm(rig: &Rig, a_url: &str, b_url: &str, request_id: u64) -> f64 {
    let config = PlayerConfig::default();
    let interrupt = Arc::new(AtomicBool::new(false));
    let mut decoder = open(b_url);
    let plan = plan_prepared_transition(
        &mut decoder,
        PreparedTransitionInputs {
            next_url: b_url,
            next_audio_stream_ordinal: None,
            current_url: Some(a_url),
            current_audio_stream_ordinal: None,
            config: &config,
            interrupt: &interrupt,
        },
    )
    .expect("plan")
    .expect("mode produces a plan");
    let b_start = plan.b_start_secs;
    decoder.prepare_seamless_seek(b_start).expect("seek B");
    decoder.set_discard_before_secs(if b_start > 0.0 { Some(b_start) } else { None });
    let predecoded = predecode_gapless_head(&mut decoder, SR).expect("predecode");
    let duration = decoder.duration_secs();
    let armed = armed_transition_from_prepared(
        plan,
        decoder,
        predecoded,
        TrackSwitchInfo::new(b_url.to_string(), None, 2, duration),
        shared::AudioSampleFormat::S16,
        0.0,
        -3.0,
        request_id,
        1,
    );
    rig.commands
        .send(DecodeCommand::ArmTransition {
            armed: Box::new(armed),
            generation: rig.shared.current_decode_generation(),
        })
        .expect("arm");
    b_start
}

#[test]
fn gapless_mode_trims_silence_and_switches_track_seq_continuously() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Gapless, 0.0);
    // 12 s track with 1.5 s of trailing silence (within the 20 % trim cap).
    let a = TestWav::new(12.0, 440.0, 120.0, 0.0, 1.5);
    let b = TestWav::new(8.0, 660.0, 120.0, 1.0, 0.0);
    let mut rig = Rig::start(&a.url());
    let b_start = prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    assert!((b_start - 1.0).abs() < 0.05, "b_start {b_start}");
    let (out, switch) = rig.drain(30.0);
    let (info, at_samples) = switch.expect("track switch signalled");
    assert_eq!(info.seq, 2);
    assert!((info.start_position_secs - 1.0).abs() < 0.05);
    // A direct hand-off switches straight to B's own loudness gain at the boundary.
    assert!((info.normalization_gain_db.unwrap() - (-3.0)).abs() < 1e-5);
    let expected_b_gain = 10.0f32.powf(-3.0 / 20.0);
    assert!(
        (rig.shared.normalization_gain() - expected_b_gain).abs() < 1e-4,
        "final normalization gain {} expected {expected_b_gain}",
        rig.shared.normalization_gain()
    );
    // A's 1.5 s trailing silence was skipped: the switch happens around 10.5 s of output.
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    assert!((switch_secs - 10.5).abs() < 0.3, "switch at {switch_secs}s");
    // Total output ≈ 10.5 s (A audible) + 7 s (B from 1 s) = 17.5 s, with no silent gap.
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!((total_secs - 17.5).abs() < 0.3, "total {total_secs}s");
    let window = (0.1 * f64::from(SR)) as usize * 2;
    for start in (0..out.len().saturating_sub(window)).step_by(window) {
        assert!(
            rms(&out[start..start + window]) > 0.01,
            "silent gap at {}s",
            start as f64 / 2.0 / f64::from(SR)
        );
    }
    assert_eq!(rig.shared.current_track_seq(), 2);
    rig.stop();
}

#[test]
fn fade_mode_overlaps_tracks_for_the_configured_duration() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Fade, 2.0);
    // Tracks must exceed `fadePlaySupportSongMinDuration` (30 s) to be overlapped.
    let a = TestWav::new(32.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(32.0, 880.0, 120.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    let (out, switch) = rig.drain(90.0);
    let (info, at_samples) = switch.expect("track switch signalled");
    assert_eq!(info.seq, 2);
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    // The boundary (UI switch) sits where the overlap starts: 32 − 2 = 30 s.
    assert!((switch_secs - 30.0).abs() < 0.3, "switch at {switch_secs}s");
    // Total = 30 s of A alone + 2 s overlap + 30 s of B alone = 62 s.
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!((total_secs - 62.0).abs() < 0.3, "total {total_secs}s");
    // Energy stays continuous through the crossover (no dip below half, no overshoot).
    let sr2 = f64::from(SR) * 2.0;
    let before = rms(&out[(29.0 * sr2) as usize..(29.5 * sr2) as usize]);
    let middle = rms(&out[(30.8 * sr2) as usize..(31.2 * sr2) as usize]);
    let after = rms(&out[(32.5 * sr2) as usize..(33.0 * sr2) as usize]);
    assert!(
        middle > before * 0.5 && middle < before * 1.6,
        "before {before} middle {middle}"
    );
    assert!(after > before * 0.5, "after {after} before {before}");
    rig.stop();
}

#[test]
fn settings_change_disarms_active_transition_runner() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Fade, 2.0);
    let a = TestWav::new(32.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(32.0, 880.0, 120.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);

    let mut buffer = vec![0.0f32; 1_024];
    let mut drained = 0usize;
    let target = (29.8 * f64::from(SR)) as usize * 2;
    let started = Instant::now();
    while drained < target && started.elapsed() < Duration::from_secs(20) {
        let frames = rig.shared.pop_into(&mut buffer);
        if frames == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        drained += frames * 2;
    }

    let reset_position_secs = rig.shared.position_secs();
    let old_generation = rig.shared.current_decode_generation();
    rig.commands
        .send(DecodeCommand::DisarmTransition {
            request_id: None,
            reset_position_secs: Some(reset_position_secs),
        })
        .expect("disarm");
    let disarm_started = Instant::now();
    while rig.shared.current_decode_generation() == old_generation
        && disarm_started.elapsed() < Duration::from_secs(5)
    {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_ne!(
        rig.shared.current_decode_generation(),
        old_generation,
        "disarm command was not processed"
    );

    let (out, switch) = rig.drain(10.0);
    assert!(switch.is_none(), "old transition still switched tracks");
    assert_eq!(rig.shared.current_track_seq(), 1);
    let remaining_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!(
        remaining_secs < 3.0,
        "disarm should resume near {reset_position_secs:.2}s, got {remaining_secs:.2}s remaining"
    );
    rig.stop();
}

#[test]
fn automix_pro_mode_blends_on_the_beat_grid_and_hands_off_cleanly() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::AutomixPro, 5.0);
    // 40 s tracks at 120 / 123 bpm: close enough for a tempo-matched blend.
    let a = TestWav::new(40.0, 330.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(40.0, 550.0, 123.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    let diagnostics = crate::control::get_transition_diagnostics()
        .expect("diagnostics")
        .expect("plan recorded");
    assert!(
        diagnostics.contains("\"mode\":\"automix-pro\""),
        "{diagnostics}"
    );
    let (out, switch) = rig.drain(120.0);
    let (info, at_samples) = switch.expect("track switch signalled");
    assert_eq!(info.seq, 2);
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    assert!(
        switch_secs > 20.0 && switch_secs < 40.0,
        "switch at {switch_secs}s"
    );
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    // A up to its cut (< 40 s) + the whole of B from its entry (≈ 40 s − b_start).
    assert!(
        total_secs > 50.0 && total_secs < 82.0,
        "total {total_secs}s"
    );
    // Nothing clips and there is no silent hole around the hand-off.
    assert!(out.iter().all(|s| s.abs() <= 1.0));
    let sr2 = f64::from(SR) * 2.0;
    let window = (0.25 * sr2) as usize;
    for start in ((switch_secs - 1.0) * sr2) as usize..((switch_secs + 8.0) * sr2) as usize {
        if start % window != 0 || start + window > out.len() {
            continue;
        }
        assert!(
            rms(&out[start..start + window]) > 0.01,
            "hole at {}s",
            start as f64 / sr2
        );
    }
    rig.stop();
}

#[test]
fn automix_basic_mode_uses_simple_exchange_on_the_grid() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::AutomixBasic, 5.0);
    // 40 s tracks at 120 / 121 bpm: within the 4 % basic tolerance → 4-bar simple exchange.
    let a = TestWav::new(40.0, 330.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(40.0, 550.0, 121.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    let diagnostics = crate::control::get_transition_diagnostics()
        .expect("diagnostics")
        .expect("plan recorded");
    assert!(
        diagnostics.contains("\"mode\":\"automix-basic\""),
        "{diagnostics}"
    );
    assert!(
        diagnostics.contains("\"template\":\"simple-exchange\""),
        "{diagnostics}"
    );
    assert!(diagnostics.contains("\"bars\":4"), "{diagnostics}");
    let (out, switch) = rig.drain(120.0);
    let (info, at_samples) = switch.expect("track switch signalled");
    assert_eq!(info.seq, 2);
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    // 4 bars at 120 bpm = 8 s before A's last downbeat (≈ 38 s).
    assert!(
        switch_secs > 28.0 && switch_secs < 34.0,
        "switch at {switch_secs}s"
    );
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!(
        total_secs > 60.0 && total_secs < 80.0,
        "total {total_secs}s"
    );
    assert!(out.iter().all(|s| s.abs() <= 1.0));
    let sr2 = f64::from(SR) * 2.0;
    let window = (0.25 * sr2) as usize;
    for start in ((switch_secs - 1.0) * sr2) as usize..((switch_secs + 10.0) * sr2) as usize {
        if start % window != 0 || start + window > out.len() {
            continue;
        }
        assert!(
            rms(&out[start..start + window]) > 0.01,
            "hole at {}s",
            start as f64 / sr2
        );
    }
    rig.stop();
}

#[test]
fn seek_during_overlap_abandons_deck_a_and_continues_on_b() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Fade, 3.0);
    let a = TestWav::new(32.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(32.0, 880.0, 120.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    // Consume until the boundary is crossed (overlap started).
    let mut buffer = vec![0.0f32; 1_024];
    let started = Instant::now();
    let mut switched = false;
    while started.elapsed() < Duration::from_secs(30) {
        let frames = rig.shared.pop_into(&mut buffer);
        if frames == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        while let Ok(()) = rig.control_rx.try_recv() {}
        if let Some(PlaybackSignal::TrackSwitch(_)) = rig.shared.take_pending_control_signal() {
            switched = true;
            break;
        }
    }
    assert!(switched, "overlap never started");
    // Seek B to 6 s mid-overlap.
    let generation = rig
        .shared
        .reset_for_decode_resume(30.0, &DspSettings::default());
    let (reply_tx, reply_rx) = sync_channel(1);
    rig.commands
        .send(DecodeCommand::Seek {
            position_secs: 30.0,
            generation,
            track_seq: Some(2),
            reply: reply_tx,
        })
        .expect("seek");
    reply_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("seek reply")
        .expect("seek ok");
    let (out, _) = rig.drain(20.0);
    // Only B's last 2 s remain.
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!((total_secs - 2.0).abs() < 0.3, "total {total_secs}s");
    assert_eq!(rig.shared.current_track_seq(), 2);
    rig.stop();
}

static TEST_SERIAL: Mutex<()> = Mutex::new(());

#[test]
fn seek_on_outgoing_track_before_the_boundary_keeps_a_live_and_rearms_b() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Fade, 3.0);
    // A = 36 s, cut at 33 s. Seek A to 20 s (UI still on A, track_seq 1) while the
    // transition is armed; the blend must still happen later from the new position.
    let a = TestWav::new(36.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(32.0, 880.0, 120.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    // Let the worker run ahead: drain ~1 s of output so decoding reaches the cut point
    // (the decoded queue holds only ~0.5 s, so the worker blocks at ≈1.5 s decoded).
    let mut buffer = vec![0.0f32; 1_024];
    let mut drained = 0usize;
    let started = Instant::now();
    while drained < SR as usize * 2 && started.elapsed() < Duration::from_secs(10) {
        let frames = rig.shared.pop_into(&mut buffer);
        if frames == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        drained += frames * 2;
    }
    // Seek A (track_seq 1) to 20 s.
    let generation = rig
        .shared
        .reset_for_decode_resume(20.0, &DspSettings::default());
    let (reply_tx, reply_rx) = sync_channel(1);
    rig.commands
        .send(DecodeCommand::Seek {
            position_secs: 20.0,
            generation,
            track_seq: Some(1),
            reply: reply_tx,
        })
        .expect("seek");
    reply_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("seek reply")
        .expect("seek ok");
    let (out, switch) = rig.drain(90.0);
    // The transition still happens later: A plays 20 s → 33 s (13 s), overlap 3 s, then B.
    let (info, at_samples) = switch.expect("track switch signalled after the seek");
    assert_eq!(info.seq, 2);
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    assert!((switch_secs - 13.0).abs() < 0.4, "switch at {switch_secs}s");
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    // 13 s of A alone + 3 s overlap + 29 s of B alone = 45 s.
    assert!((total_secs - 45.0).abs() < 0.4, "total {total_secs}s");
    rig.stop();
}

#[test]
fn manual_start_blends_from_the_audible_position_with_the_short_cap() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    set_mode(TransitionMode::Fade, 15.0);
    let a = TestWav::new(32.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(32.0, 880.0, 120.0, 0.0, 0.0);
    let mut rig = Rig::start(&a.url());
    prepare_and_arm(&rig, &a.url(), &b.url(), 1);
    // Play 2 s of A.
    let mut buffer = vec![0.0f32; 1_024];
    let mut drained = 0usize;
    let started = Instant::now();
    while drained < SR as usize * 2 * 2 && started.elapsed() < Duration::from_secs(10) {
        let frames = rig.shared.pop_into(&mut buffer);
        if frames == 0 {
            std::thread::sleep(Duration::from_millis(1));
        }
        drained += frames * 2;
    }
    // Manual "next" like CommitPreparedNextSourceTask: reset at the audible position, then
    // StartTransition with the 4 s cap.
    let resume = rig.shared.position_secs();
    let generation = rig
        .shared
        .reset_for_decode_resume(resume, &DspSettings::default());
    let (reply_tx, reply_rx) = sync_channel(1);
    rig.commands
        .send(DecodeCommand::StartTransition {
            max_overlap_secs: crate::transition::decide::MANUAL_MAX_OVERLAP_SECS,
            resume_position_secs: resume,
            generation,
            reply: reply_tx,
        })
        .expect("start");
    reply_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("start reply")
        .expect("start ok");
    let (out, switch) = rig.drain(90.0);
    let (info, at_samples) = switch.expect("track switch signalled");
    assert_eq!(info.seq, 2);
    // The blend starts immediately (boundary within the first callbacks after the reset).
    let switch_secs = at_samples as f64 / 2.0 / f64::from(SR);
    assert!(
        switch_secs < 0.3,
        "switch at {switch_secs}s after the manual start"
    );
    // Output = 4 s overlap + 28 s of B alone (32 s track).
    let total_secs = out.len() as f64 / 2.0 / f64::from(SR);
    assert!((total_secs - 32.0).abs() < 0.4, "total {total_secs}s");
    rig.stop();
}

/// Test-only sink for engine log events (the event dispatcher needs a JS callback in
/// production; here we intercept `emit_event` through the hook in `lib.rs`).
pub(crate) static TEST_EVENT_SINK: Mutex<Option<std::sync::mpsc::Sender<PlayerEvent>>> =
    Mutex::new(None);

/// Drive the real napi runtime (`initialize` → `LoadFileTask` → `PrepareNextSourceTask` →
/// natural EOF) exactly as the app does, and check that a Fade transition is actually
/// rendered. The output device cannot be opened in CI, so the audio callback is emulated
/// by draining `SharedAudio` ourselves.
#[test]
fn runtime_fade_transition_is_rendered_through_the_real_prepare_path() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let (event_tx, event_rx) = std::sync::mpsc::channel::<PlayerEvent>();
    *TEST_EVENT_SINK.lock().unwrap() = Some(event_tx);
    crate::initialize(None).expect("initialize");
    crate::set_transition_settings(Some(crate::control::TransitionSettingsOptions {
        mode: Some("fade".to_string()),
        fade_secs: Some(3.0),
    }))
    .expect("settings");
    // Realistic lengths: the fade mode refuses to overlap tracks shorter than 30 s.
    let a = TestWav::new(40.0, 440.0, 120.0, 0.0, 0.0);
    let b = TestWav::new(40.0, 880.0, 120.0, 0.0, 0.0);

    // load A (seq 1) the way `loadFile` does.
    let mut load = crate::load_file_task_for_test(a.url(), 1);
    load.compute().expect("load A");
    let shared = crate::current_shared().expect("session");
    crate::stop_output_for_test();
    shared.paused.store(false, Ordering::Release);
    // Pull a little audio so the clock advances (emulating the audio callback).
    let mut buffer = vec![0.0f32; 2_048];
    let mut out = Vec::<f32>::new();
    let pull = |shared: &SharedAudio, out: &mut Vec<f32>, buffer: &mut Vec<f32>, secs: f64| {
        let target = out.len() + (secs * f64::from(shared.mix_format.sample_rate)) as usize * 2;
        let started = Instant::now();
        while out.len() < target && started.elapsed() < Duration::from_secs(20) {
            let frames = shared.pop_into(buffer);
            if frames == 0 {
                std::thread::sleep(Duration::from_millis(1));
            } else {
                out.extend_from_slice(&buffer[..frames * 2]);
            }
        }
    };
    pull(&shared, &mut out, &mut buffer, 1.0);

    // prepare B (seq 2) the way `prepareGaplessNext` does.
    let request_id = crate::begin_next_source_preparation().expect("begin") as u64;
    assert!(request_id > 0);
    let mut prepare = crate::prepare_next_source_task_for_test(b.url(), 2, request_id, -3.0);
    let prepared = prepare.compute().expect("prepare B");
    assert!(prepared, "prepareNextSource returned false");
    let diag = crate::get_transition_diagnostics().unwrap();
    eprintln!("diag = {diag:?}");

    // Drain to the end of both tracks, recording the boundary.
    let started = Instant::now();
    let mut switch_at = None;
    loop {
        let frames = shared.pop_into(&mut buffer);
        if frames > 0 {
            out.extend_from_slice(&buffer[..frames * 2]);
        } else if shared.is_drained_for_output() {
            break;
        } else {
            std::thread::sleep(Duration::from_millis(1));
        }
        if switch_at.is_none() && shared.current_track_seq() == 2 {
            switch_at = Some(out.len());
        }
        if started.elapsed() > Duration::from_secs(60) {
            break;
        }
    }
    let logs: Vec<String> = event_rx
        .try_iter()
        .filter_map(|event| event.message)
        .collect();
    for line in &logs {
        eprintln!("LOG {line}");
    }
    let output_rate = f64::from(shared.mix_format.sample_rate);
    let total_secs = out.len() as f64 / 2.0 / output_rate;
    let switch_secs = switch_at.map(|s| s as f64 / 2.0 / output_rate);
    eprintln!("total = {total_secs:.2}s switch = {switch_secs:?}");
    crate::destroy().ok();
    *TEST_EVENT_SINK.lock().unwrap() = None;
    assert!(
        logs.iter()
            .any(|l| l.contains("transition planned: mode=fade")),
        "no plan logged"
    );
    assert!(
        logs.iter().any(|l| l.contains("song transition started")),
        "transition never started"
    );
    assert!(
        (total_secs - 77.0).abs() < 0.5,
        "expected 40 + 40 − 3 = 77 s of audio, got {total_secs}"
    );
}

/// Minimal HTTP/1.1 range server on a background thread (std only), serving files from a
/// directory. Mirrors what a CDN does for FLAC streaming: `Accept-Ranges: bytes` + 206.
struct RangeServer {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RangeServer {
    fn start(root: std::path::PathBuf) -> Self {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stop_flag.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                let root = root.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    loop {
                        let mut buf = Vec::new();
                        let mut byte = [0u8; 1];
                        while !buf.ends_with(b"\r\n\r\n") {
                            match stream.read(&mut byte) {
                                Ok(1) => buf.push(byte[0]),
                                _ => return,
                            }
                        }
                        let request = String::from_utf8_lossy(&buf).to_string();
                        let mut lines = request.lines();
                        let first = lines.next().unwrap_or_default();
                        let mut parts = first.split_whitespace();
                        let method = parts.next().unwrap_or("GET");
                        let path = parts.next().unwrap_or("/");
                        let file = root.join(path.trim_start_matches('/'));
                        let Ok(data) = std::fs::read(&file) else {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                            return;
                        };
                        let size = data.len();
                        let mut range = None;
                        for line in lines {
                            if let Some(value) = line.strip_prefix("Range: bytes=") {
                                let mut ends = value.split('-');
                                let start = ends.next().unwrap_or("").parse::<usize>().ok();
                                let end = ends.next().unwrap_or("").parse::<usize>().ok();
                                range = Some((
                                    start.unwrap_or(0),
                                    end.unwrap_or(size - 1).min(size - 1),
                                ));
                            }
                        }
                        let (status, start, end) = match range {
                            Some((s, e)) => ("206 Partial Content", s, e),
                            None => ("200 OK", 0, size - 1),
                        };
                        let body = &data[start..=end];
                        let mut header = format!(
                            "HTTP/1.1 {status}\r\nContent-Type: audio/flac\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n",
                            body.len()
                        );
                        if range.is_some() {
                            header.push_str(&format!(
                                "Content-Range: bytes {start}-{end}/{size}\r\n"
                            ));
                        }
                        header.push_str("\r\n");
                        if stream.write_all(header.as_bytes()).is_err() {
                            return;
                        }
                        if method != "HEAD" && stream.write_all(body).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self {
            port,
            stop,
            thread: Some(thread),
        }
    }

    fn url(&self, name: &str) -> String {
        format!("http://127.0.0.1:{}/{name}", self.port)
    }
}

impl Drop for RangeServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Two FLAC files served over HTTP (like the CDN in production). Reproduces the failure
/// seen in the field: preparing the next track analysed both streams via seeks into a
/// partially cached network FLAC and returned `nativeSeq: null`, so no transition ran.
#[test]
fn http_flac_prepare_survives_network_seek_errors_and_blends() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let root = std::env::temp_dir();
    let a_path = root.join("track_a.flac");
    let b_path = root.join("track_b.flac");
    if !a_path.exists() || !b_path.exists() {
        eprintln!("skipping: /tmp/track_a.flac + track_b.flac not present (generate with ffmpeg)");
        return;
    }
    let server = RangeServer::start(root);
    let (event_tx, event_rx) = std::sync::mpsc::channel::<PlayerEvent>();
    *TEST_EVENT_SINK.lock().unwrap() = Some(event_tx);
    crate::initialize(None).expect("initialize");
    crate::set_transition_settings(Some(crate::control::TransitionSettingsOptions {
        mode: Some("automix-pro".to_string()),
        fade_secs: Some(5.0),
    }))
    .expect("settings");

    let mut load = crate::load_file_task_for_test(server.url("track_a.flac"), 1);
    load.compute().expect("load A");
    let shared = crate::current_shared().expect("session");
    shared.paused.store(false, Ordering::Release);
    let mut buffer = vec![0.0f32; 4_096];
    let mut out = Vec::<f32>::new();
    // Play ~2 s, then prepare B like the renderer does 75 s before the end.
    let started = Instant::now();
    while out.len() < 2 * 2 * SR as usize && started.elapsed() < Duration::from_secs(20) {
        let frames = shared.pop_into(&mut buffer);
        if frames == 0 {
            std::thread::sleep(Duration::from_millis(1));
        } else {
            out.extend_from_slice(&buffer[..frames * 2]);
        }
    }
    let request_id = crate::begin_next_source_preparation().expect("begin") as u64;
    let mut prepare =
        crate::prepare_next_source_task_for_test(server.url("track_b.flac"), 2, request_id, -3.0);
    let prepare_started = Instant::now();
    let prepared = prepare.compute();
    eprintln!(
        "prepare took {:?} → {:?}",
        prepare_started.elapsed(),
        prepared.as_ref().map(|_| ())
    );
    let logs: Vec<String> = event_rx.try_iter().filter_map(|e| e.message).collect();
    for line in &logs {
        eprintln!("LOG {line}");
    }
    crate::destroy().ok();
    *TEST_EVENT_SINK.lock().unwrap() = None;
    assert!(
        prepared.expect("prepare must not error"),
        "prepare returned false"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("transition planned: mode=automix-pro")),
        "no plan logged"
    );
    assert!(
        logs.iter()
            .any(|l| l.contains("gapless prepared next source") && l.contains("transition=true")),
        "prepared source not armed"
    );
}

#[test]
fn probe_http_flac_seek_behaviour() {
    let _guard = TEST_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
    let root = std::env::temp_dir();
    if !root.join("track_a.flac").exists() {
        return;
    }
    let server = RangeServer::start(root);
    let config = PlayerConfig::default();
    let interrupt = Arc::new(AtomicBool::new(false));
    let url = server.url("track_a.flac");
    let mut decoder = DecoderData::open(
        url.clone(),
        None,
        None,
        interrupt.clone(),
        config.packet_cache_options_for_url(&url),
        &config.stream_options(),
    )
    .expect("open http flac");
    eprintln!("duration = {}", decoder.duration_secs());
    for target in [1.0, 60.0, 110.0, 150.0, 190.0] {
        let started = Instant::now();
        let r = decoder.prepare_seamless_seek(target);
        eprintln!(
            "seek {target}: {:?} in {:?}",
            r.as_ref().map(|_| ()),
            started.elapsed()
        );
        if r.is_ok() {
            match decoder.decode_next_chunk() {
                Ok(Some(c)) => eprintln!("   first chunk pts {:?} frames {}", c.pts_secs, c.frames),
                other => eprintln!("   decode: {:?}", other.map(|c| c.map(|c| c.frames))),
            }
        }
    }
    // Local file for comparison.
    let local = std::env::temp_dir()
        .join("track_a.flac")
        .to_string_lossy()
        .into_owned();
    let mut local_decoder = DecoderData::open(
        local.clone(),
        None,
        None,
        Arc::new(AtomicBool::new(false)),
        config.packet_cache_options_for_url(&local),
        &config.stream_options(),
    )
    .expect("open local");
    let r = local_decoder.prepare_seamless_seek(110.0);
    eprintln!("LOCAL seek 110: {:?}", r.as_ref().map(|_| ()));
}
