use std::{
    io::Cursor,
    time::Duration,
};

use ffmpeg_audio::{
    AudioReader,
    RawAudioData,
    ResampleOptions,
    SeekMode,
};

fn generate_sine_wav(duration_secs: f32) -> Vec<u8> {
    let sample_rate: u32 = 44100;
    let freq: f32 = 440.0;
    let num_samples = (sample_rate as f32 * duration_secs) as u32;

    let mut data = Vec::with_capacity(44 + (num_samples * 2) as usize);

    data.extend_from_slice(b"RIFF");
    let file_size = 36 + num_samples * 2;
    data.extend_from_slice(&file_size.to_le_bytes());
    data.extend_from_slice(b"WAVE");

    data.extend_from_slice(b"fmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate * 2;
    data.extend_from_slice(&byte_rate.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());

    data.extend_from_slice(b"data");
    let data_size = num_samples * 2;
    data.extend_from_slice(&data_size.to_le_bytes());

    for i in 0..num_samples {
        let t = i as f32 / sample_rate as f32;
        let sample = (f32::sin(2.0 * std::f32::consts::PI * freq * t) * 16000.0) as i16;
        data.extend_from_slice(&sample.to_le_bytes());
    }

    data
}

#[test]
fn test_audio_pipeline_and_signal_validation() {
    let wav_data = generate_sine_wav(1.0);
    let source = Cursor::new(wav_data);

    let target_sample_rate = 48000;
    let target_channels = 2;

    let reader = AudioReader::new(source).expect("初始化 AudioReader 失败");

    let options = ResampleOptions::new()
        .sample_rate(target_sample_rate)
        .channels(target_channels)
        .format::<f32>();

    let mut resampled = reader
        .into_resampled(options)
        .expect("初始化 ResampledReader 失败");

    let mut total_samples = 0;
    let mut energy_sum: f64 = 0.0;

    while let Some(frame) = resampled
        .receive_frame_as::<f32>()
        .expect("解码过程中发生错误")
    {
        assert_eq!(
            frame.len() % target_channels as usize,
            0,
            "输出缓冲区长度未与声道数对齐"
        );

        for &sample in frame {
            energy_sum = f64::from(sample).mul_add(f64::from(sample), energy_sum);
        }
        total_samples += frame.len();
    }

    assert!(
        (95900..=96100).contains(&total_samples),
        "样本数量异常! 预期约 96000，实际为 {total_samples}"
    );

    let rms = f64::sqrt(energy_sum / total_samples as f64);
    assert!(
        rms > 0.1,
        "静音错误：重采样器输出的几乎全是 0.0，波形能量过低 (RMS: {rms})"
    );
}

#[test]
fn test_audio_duration() {
    let wav_data = generate_sine_wav(2.0);
    let source = Cursor::new(wav_data);

    let reader = AudioReader::new(source).unwrap();
    let duration = reader.duration().expect("应能拿到 WAV 时长");
    let secs = duration.as_secs_f64();
    assert!((1.99..=2.01).contains(&secs), "时长应约为 2s，实际 {secs}");
}

#[test]
fn test_audio_seek_functionality() {
    let wav_data = generate_sine_wav(2.0);
    let source = Cursor::new(wav_data);

    let reader = AudioReader::new(source).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    let _ = resampled.receive_frame_as::<f32>().unwrap();
    let _ = resampled.receive_frame_as::<f32>().unwrap();

    let target = Duration::from_secs_f32(1.0);
    resampled
        .seek(target, SeekMode::default())
        .expect("Seek 调用失败");

    let frame_after_seek = resampled
        .receive_frame_as::<f32>()
        .expect("Seek 后读取帧报错")
        .expect("Seek 后立刻遇到了非预期的 EOF");

    assert!(!frame_after_seek.is_empty(), "Seek 后读取到了空数据包");
}

#[test]
fn test_stream_position_initially_none() {
    let wav_data = generate_sine_wav(1.0);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    assert!(
        reader.stream_position().is_none(),
        "解码开始前，stream_position 应为 None"
    );
}

#[test]
fn test_stream_position_advances() {
    let wav_data = generate_sine_wav(1.0);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    resampled.receive_frame_as::<f32>().unwrap();
    let first_pts = resampled.source().stream_position();
    assert!(
        first_pts.is_some(),
        "解码至少一帧后，stream_position 应为 Some"
    );

    while resampled.receive_frame_as::<f32>().unwrap().is_some() {}
    let last_pts = resampled.source().stream_position();
    assert!(
        last_pts >= first_pts,
        "播放时间应随解码推进而增大，first={first_pts:?} last={last_pts:?}"
    );
}

#[test]
fn test_stream_position_resets_after_seek() {
    let wav_data = generate_sine_wav(2.0);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    resampled.receive_frame_as::<f32>().unwrap();
    assert!(resampled.source().stream_position().is_some());

    resampled
        .seek(Duration::from_secs(0), SeekMode::default())
        .unwrap();
    assert!(
        resampled.source().stream_position().is_none(),
        "Seek 后 stream_position 应重置为 None"
    );
}

#[test]
fn test_scan_duration_resumes_after_the_current_frame() {
    let wav_data = generate_sine_wav(1.0);
    let mut reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    let first_pts = {
        let frame = reader.receive_frame().unwrap().unwrap();
        frame.pts().unwrap()
    };

    reader
        .scan_exact_duration(ffmpeg_audio::ScanMode::Frame)
        .unwrap();

    let next_pts = {
        let frame = reader.receive_frame().unwrap().unwrap();
        frame.pts().unwrap()
    };

    assert!(
        next_pts > first_pts,
        "scan 后不应重新交付已经消费的帧: first={first_pts:?}, next={next_pts:?}"
    );
}

#[test]
fn test_full_decode_no_panic() {
    let wav_data = generate_sine_wav(1.0);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    while resampled.receive_frame_as::<f32>().unwrap().is_some() {}
}

#[test]
fn test_seek_updates_pts_and_aligns_target() {
    let wav_data = generate_sine_wav(2.0);
    let source = Cursor::new(wav_data);

    let reader = AudioReader::new(source).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    resampled.receive_frame_as::<f32>().unwrap();
    resampled.receive_frame_as::<f32>().unwrap();

    let target = Duration::from_secs_f32(1.0);
    resampled
        .seek(target, SeekMode::Accurate)
        .expect("Seek 调用失败");

    assert!(
        resampled.source().stream_position().is_none(),
        "Seek 调用后，在拉取新帧之前，PTS 必须处于重置状态"
    );

    let frame_after_seek = resampled
        .receive_frame_as::<f32>()
        .expect("Seek 后读取帧报错")
        .expect("Seek 后立刻遇到了非预期的 EOF");

    assert!(!frame_after_seek.is_empty(), "Seek 后读取到了空数据包");

    let post_seek_pts = resampled
        .source()
        .stream_position()
        .expect("拉取缓冲帧后 PTS 为 None");

    let diff_ms = if post_seek_pts > target {
        post_seek_pts.checked_sub(target).unwrap().as_millis()
    } else {
        target.checked_sub(post_seek_pts).unwrap().as_millis()
    };

    assert!(
        diff_ms < 10,
        "Seek 不精确：目标时间 {target:?}, 实际到达时间 {post_seek_pts:?}, 误差 {diff_ms}"
    );
}

#[test]
fn test_seek_near_eof_does_not_panic_or_loop() {
    let wav_data = generate_sine_wav(1.0);
    let source = Cursor::new(wav_data);

    let reader = AudioReader::new(source).unwrap();
    let mut resampled = reader
        .into_resampled(
            ResampleOptions::new()
                .sample_rate(48000)
                .channels(2)
                .format::<f32>(),
        )
        .unwrap();

    let target = Duration::from_secs_f32(0.99);
    resampled.seek(target, SeekMode::default()).unwrap();

    let mut frames_read = 0;
    while resampled.receive_frame_as::<f32>().unwrap().is_some() {
        frames_read += 1;
        assert!(frames_read < 10, "在文件末尾拉取了过多的帧");
    }

    assert!(
        frames_read > 0,
        "逼近末尾的跳转至少应该能读取到最后的几帧音频"
    );
}

#[test]
fn test_planar_audio_pipeline_and_signal_validation() {
    let wav_data = generate_sine_wav(1.0);
    let source = Cursor::new(wav_data);

    let target_sample_rate = 48000;
    let target_channels = 2;

    let reader = AudioReader::new(source).expect("初始化 AudioReader 失败");

    let options = ResampleOptions::new()
        .sample_rate(target_sample_rate)
        .channels(target_channels)
        .format_planar::<f32>();

    let mut resampled = reader
        .into_resampled(options)
        .expect("初始化 ResampledReader 失败");

    let mut total_samples_per_channel = 0;
    let mut energy_sum_ch0: f64 = 0.0;
    let mut energy_sum_ch1: f64 = 0.0;

    while let Some(channels) = resampled
        .receive_planar_as::<f32>()
        .expect("解码平面数据时发生错误")
    {
        assert_eq!(
            channels.len(),
            target_channels as usize,
            "返回的声道列表长度与目标声道数不匹配"
        );

        let samples_this_frame = channels[0].len();
        assert_eq!(
            channels[1].len(),
            samples_this_frame,
            "不同声道的切片长度出现不一致（Planar内存切片错误）"
        );

        for &sample in channels[0] {
            energy_sum_ch0 = f64::from(sample).mul_add(f64::from(sample), energy_sum_ch0);
        }
        for &sample in channels[1] {
            energy_sum_ch1 = f64::from(sample).mul_add(f64::from(sample), energy_sum_ch1);
        }

        total_samples_per_channel += samples_this_frame;
    }

    assert!(
        (47900..=48100).contains(&total_samples_per_channel),
        "单声道样本数量异常! 预期约 48000，实际为 {total_samples_per_channel}"
    );

    let rms_ch0 = f64::sqrt(energy_sum_ch0 / total_samples_per_channel as f64);
    let rms_ch1 = f64::sqrt(energy_sum_ch1 / total_samples_per_channel as f64);

    assert!(rms_ch0 > 0.1, "声道 0 输出为空或能量过低");
    assert!(rms_ch1 > 0.1, "声道 1 输出为空或能量过低");
}

#[test]
fn test_planar_format_mismatch_rejection_packed_to_planar() {
    let wav_data = generate_sine_wav(0.1);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    let mut resampled = reader
        .into_resampled(ResampleOptions::new().format::<f32>())
        .unwrap();

    let result = resampled.receive_planar_as::<f32>();

    assert!(
        matches!(result, Err(ffmpeg_audio::AudioError::FormatMismatch)),
        "期望返回 FormatMismatch 错误，但得到了: {result:?}"
    );
}

#[test]
fn test_planar_format_mismatch_rejection_planar_to_packed() {
    let wav_data = generate_sine_wav(0.1);
    let reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    let mut resampled = reader
        .into_resampled(ResampleOptions::new().format_planar::<f32>())
        .unwrap();

    let result = resampled.receive_frame_as::<f32>();

    assert!(
        matches!(result, Err(ffmpeg_audio::AudioError::FormatMismatch)),
        "期望返回 FormatMismatch 错误，但得到了: {result:?}"
    );
}

#[test]
fn test_raw_data_extraction_packed_and_type_safety() {
    let wav_data = generate_sine_wav(0.1);
    let mut reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    let channels = reader.source_info().channels as usize;

    let frame = reader.receive_frame().unwrap().expect("应能读取到 WAV 帧");

    let err_result = frame.raw_data::<f32>();
    assert!(
        matches!(err_result, Err(ffmpeg_audio::AudioError::FormatMismatch)),
        "期望类型不匹配错误，但得到了: {err_result:?}"
    );

    let raw = frame.raw_data::<i16>().expect("提取 i16 原始数据失败");

    match raw {
        RawAudioData::Packed(data) => {
            let expected_len = frame.samples() * channels;

            assert_eq!(
                data.len(),
                expected_len,
                "Packed 切片的元素总数 ({}) 应等于逻辑样本数 ({}) 乘以声道数 ({})",
                data.len(),
                frame.samples(),
                channels
            );

            let has_signal = data.iter().any(|&s| s != 0);
            assert!(has_signal, "捞出的原始 PCM 不应全为静音");
        }
        RawAudioData::Planar(_) => panic!("WAV 应该被解码为 Packed 布局，却得到了 Planar"),
    }
}

#[test]
fn test_raw_data_signal_integrity_across_frames() {
    let sample_rate = 44100;
    let freq: f32 = 440.0;
    let duration = 0.1;

    let wav_data = generate_sine_wav(duration);
    let mut reader = AudioReader::new(Cursor::new(wav_data)).unwrap();

    let mut global_sample_index = 0;

    while let Some(frame) = reader.receive_frame().unwrap() {
        let raw = frame.raw_data::<i16>().expect("提取 i16 失败");

        if let RawAudioData::Packed(data) = raw {
            for &actual_sample in data {
                let t = global_sample_index as f32 / sample_rate as f32;
                let expected_sample =
                    (f32::sin(2.0 * std::f32::consts::PI * freq * t) * 16000.0) as i16;

                let diff = (i32::from(actual_sample) - i32::from(expected_sample)).abs();
                assert!(
                    diff <= 1,
                    "信号失真！在全局样本索引 {global_sample_index} 期望 {expected_sample}, 实际得到 {actual_sample}"
                );

                global_sample_index += 1;
            }
        } else {
            panic!("WAV 应为 Packed 格式");
        }
    }

    assert_eq!(global_sample_index, 4410, "解码出的样本总数不对");
}

#[cfg(not(target_arch = "wasm32"))]
mod file_tests {
    use std::fs::File;

    use super::*;

    const AAC_SEEK_PATH: &str = "tests/assets/seek_test.aac";
    const MUTATION_AAC_PATH: &str = "tests/assets/format_mutation.aac";
    const NEGATIVE_PTS_MKV_PATH: &str = "tests/assets/negative_pts.mkv";

    #[test]
    fn test_seek_accuracy() {
        let file = File::open(AAC_SEEK_PATH).expect("Failed to open AAC test asset");
        let mut reader = AudioReader::new(file).unwrap();

        let target = Duration::from_millis(501);

        reader.seek(target, SeekMode::Coarse).unwrap();
        let (coarse_pts, coarse_samples) = {
            let frame = reader.receive_frame().unwrap().unwrap();
            (frame.pts().unwrap(), frame.samples())
        };

        assert!(coarse_pts < target, "Coarse seek PTS should be < target");

        reader.seek(target, SeekMode::Accurate).unwrap();
        let (accurate_pts, accurate_samples) = {
            let frame = reader.receive_frame().unwrap().unwrap();
            (frame.pts().unwrap(), frame.samples())
        };

        assert_eq!(
            accurate_pts.as_millis(),
            target.as_millis(),
            "Accurate seek PTS must exactly match the target"
        );

        assert!(
            accurate_samples < coarse_samples,
            "Accurate frame should be trimmed ({accurate_samples} < {coarse_samples})"
        );
    }

    #[test]
    fn test_hot_reload_on_format_mutation() {
        let file = File::open(MUTATION_AAC_PATH).unwrap();
        let reader = AudioReader::new(file).unwrap();

        let options = ResampleOptions::new()
            .format::<f32>()
            .channels(2)
            .sample_rate(48000);

        let mut resampled_reader = reader.into_resampled(options).unwrap();

        let mut total_samples = 0;

        loop {
            match resampled_reader.receive_frame_as::<f32>() {
                Ok(Some(samples)) => {
                    assert_eq!(
                        samples.len() % 2,
                        0,
                        "Output slice must be interleaved stereo"
                    );
                    total_samples += samples.len() / 2;
                }
                Ok(None) => break,
                Err(e) => panic!("Failed to receive frame: {e:?}"),
            }
        }

        assert!(
            total_samples > 0,
            "Should have successfully decoded mutated stream"
        );
    }

    #[test]
    fn test_raw_data_extraction_planar_with_seek_offset() {
        let file = File::open(AAC_SEEK_PATH).expect("Failed to open AAC test asset");
        let mut reader = AudioReader::new(file).unwrap();

        let expected_channels = reader.source_info().channels as usize;

        let target = Duration::from_millis(501);
        reader.seek(target, SeekMode::Accurate).unwrap();

        let frame = reader.receive_frame().unwrap().expect("Seek 后读取帧失败");

        assert!(frame.samples() > 0, "修剪后应仍有剩余数据");

        let raw = frame.raw_data::<f32>().expect("提取 f32 原始数据失败");

        match raw {
            RawAudioData::Planar(planes) => {
                assert_eq!(
                    planes.len(),
                    expected_channels,
                    "返回的平面切片数量 ({}) 应等于文件的物理声道数 ({})",
                    planes.len(),
                    expected_channels
                );

                for (ch_idx, plane) in planes.iter().enumerate() {
                    assert_eq!(
                        plane.len(),
                        frame.samples(),
                        "声道 {ch_idx} 的切片长度未与修剪后的样本数对齐"
                    );

                    let has_signal = plane.iter().any(|&s| s.abs() > 0.0);
                    assert!(has_signal, "提取出来的声道 {ch_idx} 数据异常");
                }
            }
            RawAudioData::Packed(_) => panic!("AAC 应该被解码为 Planar 布局，却得到了 Packed"),
        }
    }

    #[test]
    fn test_blocks_negative_pts_from_raw_container() {
        // ffmpeg -f lavfi -i "aevalsrc=sin(440*2*PI*t):s=48000:d=1" -c:a pcm_s16le
        // -output_ts_offset -0.1 -avoid_negative_ts disabled -y negative_pts.mkv
        let file = std::fs::File::open(NEGATIVE_PTS_MKV_PATH).unwrap();
        let mut reader = AudioReader::new(file).unwrap();

        let mut total_samples = 0;
        let mut first_frame_pts = None;

        while let Some(frame) = reader.receive_frame().unwrap() {
            if first_frame_pts.is_none() {
                first_frame_pts = frame.pts();

                assert_eq!(
                    first_frame_pts.unwrap().as_millis(),
                    0,
                    "First output frame is not aligned to 0ms"
                );
            }
            total_samples += frame.samples();
        }

        // 1. The MKV container timebase is 1/1000s (millisecond precision).
        // 2. 1024 samples per packet at 48kHz (approx. 21.33ms).
        // 3. After millisecond quantization, the PTS of the 5th packet is marked as -15ms.
        // 4. Remove the first 4 packets (4096) and the first 15ms of the 5th packet (720 samples),
        //    totaling 4816 samples removed.
        // 5. The final remaining valid sample count is 43184.
        assert_eq!(
            total_samples, 43_184,
            "Should trim exactly 0.1s of negative PTS data. Expected 43184 samples, got {total_samples}"
        );
    }
}
