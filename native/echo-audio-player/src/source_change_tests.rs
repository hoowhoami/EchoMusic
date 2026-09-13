//! Deterministic transport races; no physical audio device is required.
use super::*;

#[test]
fn source_change_retains_output_session_but_drains_and_invalidates_old_audio() {
    initialize(None).unwrap();
    let shared = Arc::new(SharedAudio::new(
        shared::MixFormat::stereo_f32(44_100),
        0.2,
        8.0,
        &DspSettings::default(),
    ));
    shared.paused.store(false, Ordering::Release);
    shared.set_track_seq(1);
    shared.set_position_secs(90.0);
    let old_generation = shared.current_decode_generation();
    assert!(shared.push_samples(&[0.5; 256]));
    let session_shared = shared.clone();
    let pending_interrupt = Arc::new(AtomicBool::new(false));
    let interrupt = pending_interrupt.clone();
    let old_request = next_source_open_request_seq();
    call_core_command("test-source-change-session", move |runtime| {
        runtime.session = Some(PlaybackSession {
            shared: session_shared.clone(),
            output_thread: None,
            filter_thread: None,
            decode_thread: None,
            decode_commands: None,
            position_thread: None,
        });
        set_current_shared(Some(session_shared));
        runtime.current_url = Some("old-source".to_string());
        runtime.state.playing = true;
        runtime.state.paused = false;
        runtime.begin_source_open(old_request, interrupt);
        Ok(())
    })
    .unwrap();
    let mut old_play = PlayTask {
        source_request_seq: old_request,
    };
    let mut old_load = load_file_task_for_test("must-not-be-opened".to_string(), 2);

    for _ in 0..12 {
        begin_source_change().unwrap();
    }
    old_play.compute().unwrap();
    old_load.compute().unwrap();

    assert!(Arc::ptr_eq(&shared, &current_shared().unwrap()));
    assert!(pending_interrupt.load(Ordering::Acquire));
    assert!(shared.paused.load(Ordering::Acquire));
    assert!(shared.current_decode_generation() > old_generation);
    assert!(
        !shared.push_output_samples_with_source_frames_for_decode_generation(
            &[0.5; 256],
            128,
            old_generation
        )
    );
    let mut output = [1.0; 256];
    assert_eq!(shared.pop_into(&mut output), 0);
    assert_eq!(output, [0.0; 256]);
    assert_eq!(shared.position_secs(), 0.0);
    assert!(!get_state().unwrap().playing);
    let mut current_play = PlayTask {
        source_request_seq: LATEST_SOURCE_OPEN_REQUEST_SEQ.load(Ordering::Acquire),
    };
    assert!(current_play
        .compute()
        .unwrap_err()
        .reason
        .contains("no audio source loaded"));
    destroy().unwrap();
}

#[test]
fn latest_load_produces_new_audio_and_an_advancing_clock_after_rapid_skips() {
    initialize(None).unwrap();
    let shared = Arc::new(SharedAudio::new(
        shared::MixFormat::stereo_f32(44_100),
        0.2,
        8.0,
        &DspSettings::default(),
    ));
    assert!(shared.push_samples(&[0.5; 512]));
    let session_shared = shared.clone();
    call_core_command("test-latest-load-session", move |runtime| {
        runtime.session = Some(PlaybackSession {
            shared: session_shared.clone(),
            output_thread: None,
            filter_thread: Some(filter::spawn_filter_thread(session_shared.clone())),
            decode_thread: None,
            decode_commands: None,
            position_thread: None,
        });
        set_current_shared(Some(session_shared));
        runtime.current_url = Some("old-source".to_string());
        Ok(())
    })
    .unwrap();

    // The replacement is a negative constant; any positive PCM is stale old audio.
    let samples = 44_100u32 * 2;
    let mut wav = Vec::new();
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + samples * 2).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&44_100u32.to_le_bytes());
    wav.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
    wav.extend_from_slice(&4u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(samples * 2).to_le_bytes());
    for _ in 0..samples {
        wav.extend_from_slice(&(-8192i16).to_le_bytes());
    }
    let path = std::env::temp_dir().join(format!("echo-latest-source-{}.wav", std::process::id()));
    std::fs::write(&path, wav).unwrap();

    let mut stale = Vec::new();
    for seq in 1..12 {
        begin_source_change().unwrap();
        stale.push(load_file_task_for_test(
            "must-not-be-opened".to_string(),
            seq,
        ));
    }
    begin_source_change().unwrap();
    let mut latest = load_file_task_for_test(path.to_string_lossy().into_owned(), 12);
    latest.compute().expect("latest source loads");
    for mut task in stale.into_iter().rev() {
        task.compute().unwrap();
    }
    assert_eq!(shared.current_track_seq(), 12);
    shared.paused.store(false, Ordering::Release);
    let mut output = [0.0; 512];
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let frames = loop {
        let frames = shared.pop_into(&mut output);
        if frames > 0 {
            break frames;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "new decoder must feed retained output"
        );
        thread::sleep(Duration::from_millis(1));
    };
    assert!(output[..frames * 2].iter().any(|sample| *sample < -0.1));
    assert!(output[..frames * 2].iter().all(|sample| *sample <= 0.001));
    assert!(shared.position_secs() > 0.0);
    destroy().unwrap();
    std::fs::remove_file(path).unwrap();
}
