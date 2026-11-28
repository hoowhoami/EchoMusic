use ffmpeg_audio::{AudioReader, PacketCacheOptions, RawAudioData, SeekMode};
use std::{
    io::Cursor,
    time::{Duration, Instant},
};

fn wav() -> Vec<u8> {
    let bytes = 44_100u32 * 2 * 5;
    let mut data = Vec::with_capacity(44 + bytes as usize);
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(bytes + 36).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&44_100u32.to_le_bytes());
    data.extend_from_slice(&88_200u32.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&bytes.to_le_bytes());
    for i in 0..bytes / 2 {
        data.extend_from_slice(&((i as i16).wrapping_mul(37)).to_le_bytes());
    }
    data
}

fn wait_prefetch(reader: &AudioReader) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let stats = reader.packet_cache_stats();
        assert!(!stats.has_error);
        if stats.eof {
            return;
        }
        assert!(Instant::now() < deadline, "prefetch did not finish");
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn pcm(reader: &mut AudioReader) -> (Option<Duration>, Vec<i16>) {
    let mut samples = Vec::new();
    let mut first = None;
    while let Some(frame) = reader.receive_frame().unwrap() {
        if first.is_none() {
            first = frame.pts();
        }
        match frame.raw_data::<i16>().unwrap() {
            RawAudioData::Packed(data) => samples.extend_from_slice(data),
            RawAudioData::Planar(_) => panic!("test WAV must be packed"),
        }
    }
    (first, samples)
}

#[test]
fn disk_cache_preserves_pcm_and_cached_and_uncached_accurate_seeks() {
    let directory = tempfile::tempdir().unwrap();
    for back in [0, 1024 * 1024] {
        let open = |disk| {
            AudioReader::new_with_audio_stream_and_packet_cache(
                Cursor::new(wav()),
                None,
                PacketCacheOptions::new(1024 * 1024, back, Duration::from_secs(60))
                    .with_disk_cache(disk, Some(directory.path().to_path_buf())),
            )
            .unwrap()
        };
        let mut memory = open(false);
        let mut disk = open(true);
        wait_prefetch(&memory);
        wait_prefetch(&disk);
        assert_eq!(pcm(&mut memory), pcm(&mut disk));
        let before = disk.packet_cache_stats();
        assert!(before.file_cache_bytes.unwrap() > 400_000);
        assert!(before.disk_cache_error.is_none());
        for target in [2500, 200, 4100, 1500] {
            for reader in [&mut memory, &mut disk] {
                reader
                    .seek(Duration::from_millis(target), SeekMode::Accurate)
                    .unwrap();
                wait_prefetch(reader);
            }
            assert_eq!(
                pcm(&mut memory),
                pcm(&mut disk),
                "back={back}, seek={target}"
            );
        }
        drop(disk);
        drop(memory);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}

#[test]
fn creation_failure_uses_memory_and_retains_the_real_error() {
    let directory = tempfile::tempdir().unwrap();
    let blocked = directory.path().join("not-a-directory");
    std::fs::write(&blocked, b"keep").unwrap();
    let mut reader = AudioReader::new_with_audio_stream_and_packet_cache(
        Cursor::new(wav()),
        None,
        PacketCacheOptions::new(1024 * 1024, 0, Duration::from_secs(60))
            .with_disk_cache(true, Some(blocked.clone())),
    )
    .unwrap();
    let stats = reader.packet_cache_stats();
    assert!(stats.file_cache_bytes.is_none());
    assert!(stats.disk_cache_error.unwrap().contains("creation failed"));
    let mut memory = AudioReader::new(Cursor::new(wav())).unwrap();
    assert_eq!(pcm(&mut memory), pcm(&mut reader));
    assert_eq!(std::fs::read(blocked).unwrap(), b"keep");
}

#[test]
fn compressed_flac_disk_cache_matches_memory_through_seek() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../tests/fixtures/gapless-silence.flac");
    let open = |disk| {
        AudioReader::new_with_audio_stream_and_packet_cache(
            std::fs::File::open(&path).unwrap(),
            None,
            PacketCacheOptions::new(4 * 1024 * 1024, 4 * 1024 * 1024, Duration::from_secs(60))
                .with_disk_cache(disk, None),
        )
        .unwrap()
    };
    let mut memory = open(false);
    let mut disk = open(true);
    wait_prefetch(&memory);
    wait_prefetch(&disk);
    assert_eq!(pcm(&mut memory), pcm(&mut disk));
    for millis in [12000, 1000, 7500] {
        memory
            .seek(Duration::from_millis(millis), SeekMode::Accurate)
            .unwrap();
        disk.seek(Duration::from_millis(millis), SeekMode::Accurate)
            .unwrap();
        assert_eq!(pcm(&mut memory), pcm(&mut disk));
    }
}

#[test]
fn compressed_aac_matches_memory_including_planar_pcm_and_timestamps() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/assets/seek_test.aac");
    let open = |disk| {
        AudioReader::new_with_audio_stream_and_packet_cache(
            std::fs::File::open(&path).unwrap(),
            None,
            PacketCacheOptions::new(8 * 1024 * 1024, 8 * 1024 * 1024, Duration::from_secs(3600))
                .with_disk_cache(disk, None),
        )
        .unwrap()
    };
    let mut memory = open(false);
    let mut disk = open(true);
    wait_prefetch(&memory);
    wait_prefetch(&disk);
    fn drain(reader: &mut AudioReader) -> Vec<(Option<Duration>, Vec<u32>)> {
        let mut output = Vec::new();
        while let Some(frame) = reader.receive_frame().unwrap() {
            let bits = match frame.raw_data::<f32>().unwrap() {
                RawAudioData::Packed(data) => data.iter().map(|value| value.to_bits()).collect(),
                RawAudioData::Planar(planes) => planes
                    .iter()
                    .flat_map(|plane| plane.iter().map(|value| value.to_bits()))
                    .collect(),
            };
            output.push((frame.pts(), bits));
        }
        output
    }
    assert_eq!(drain(&mut memory), drain(&mut disk));
    for target in [1000, 500] {
        memory
            .seek(Duration::from_millis(target), SeekMode::Accurate)
            .unwrap();
        disk.seek(Duration::from_millis(target), SeekMode::Accurate)
            .unwrap();
        assert_eq!(drain(&mut memory), drain(&mut disk));
    }
}

#[test]
fn scanning_a_disk_cached_reader_preserves_pcm_position() {
    for mode in [
        ffmpeg_audio::ScanMode::Packet,
        ffmpeg_audio::ScanMode::Frame,
    ] {
        let open = |disk| {
            AudioReader::new_with_audio_stream_and_packet_cache(
                Cursor::new(wav()),
                None,
                PacketCacheOptions::new(1024 * 1024, 1024 * 1024, Duration::from_secs(60))
                    .with_disk_cache(disk, None),
            )
            .unwrap()
        };
        let mut reference = open(false);
        let mut disk = open(true);
        wait_prefetch(&reference);
        wait_prefetch(&disk);
        for reader in [&mut reference, &mut disk] {
            for _ in 0..3 {
                assert!(reader.receive_frame().unwrap().is_some());
            }
        }
        let position = disk.stream_position();
        assert!(disk.scan_exact_duration(mode).unwrap().is_some());
        assert_eq!(disk.stream_position(), position);
        assert_eq!(pcm(&mut reference), pcm(&mut disk));
    }
}

/// Run the prebuilt test executable in separate processes under an OS memory
/// profiler. Source is an explicitly supplied generated file; never an account URL.
#[test]
#[ignore = "manual Release memory/latency measurement"]
fn disk_cache_memory_latency_probe() {
    let path =
        std::env::var_os("ECHO_DISK_CACHE_PROBE_FILE").expect("generated source file required");
    let disk = std::env::var("ECHO_DISK_CACHE_PROBE_MODE").unwrap() == "disk";
    let start = Instant::now();
    let mut reader = AudioReader::new_with_audio_stream_and_packet_cache(
        std::fs::File::open(path).unwrap(),
        None,
        PacketCacheOptions::new(
            150 * 1024 * 1024,
            50 * 1024 * 1024,
            Duration::from_secs(3600),
        )
        .with_disk_cache(disk, None),
    )
    .unwrap();
    assert!(reader.receive_frame().unwrap().is_some());
    let first_ms = start.elapsed().as_secs_f64() * 1000.;
    wait_prefetch(&reader);
    let prefetch_ms = start.elapsed().as_secs_f64() * 1000.;
    let stats = reader.packet_cache_stats();
    let mut seeks = Vec::new();
    for seconds in [2, 10, 20, 30, 40].into_iter().cycle().take(30) {
        let start = Instant::now();
        reader
            .seek(Duration::from_secs(seconds), SeekMode::Accurate)
            .unwrap();
        assert!(reader.receive_frame().unwrap().is_some());
        seeks.push(start.elapsed().as_secs_f64() * 1000.);
    }
    seeks.sort_by(f64::total_cmp);
    println!(
        "disk_cache_probe disk={disk} file_bytes={} retained_bytes={} first_ms={first_ms:.3} prefetch_ms={prefetch_ms:.3} seek_median_ms={:.3} seek_p95_ms={:.3}",
        stats.file_cache_bytes.unwrap_or(0),
        stats.total_bytes,
        seeks[15],
        seeks[28]
    );
}
