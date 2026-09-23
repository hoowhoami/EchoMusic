use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use airplay_crypto::chacha::{AudioCipher, ControlCipher};

/// Benchmark audio packet encryption with sequence-based nonces.
///
/// This is the hottest path in the application - called ~125 times/sec
/// for 44.1kHz audio with 352-sample frames.
fn bench_audio_encryption(c: &mut Criterion) {
    let mut group = c.benchmark_group("audio_encryption");

    // Test with realistic audio packet sizes
    for size in [352, 1024, 4096] {
        group.throughput(Throughput::Bytes(size as u64));

        let cipher = AudioCipher::new([0x42u8; 32]);
        let audio_data = vec![0xABu8; size];

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                cipher.encrypt_with_seq(
                    black_box(&audio_data),
                    black_box(12345),
                    black_box(0xDEADBEEF),
                    black_box(1),
                )
            });
        });
    }

    group.finish();
}

/// Benchmark audio packet decryption.
fn bench_audio_decryption(c: &mut Criterion) {
    let mut group = c.benchmark_group("audio_decryption");

    for size in [352, 1024, 4096] {
        group.throughput(Throughput::Bytes(size as u64));

        let cipher = AudioCipher::new([0x42u8; 32]);
        let audio_data = vec![0xABu8; size];
        let timestamp = 12345u32;
        let ssrc = 0xDEADBEEFu32;

        let (ciphertext, nonce, tag) = cipher.encrypt_with_seq(&audio_data, timestamp, ssrc, 1).unwrap();

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                cipher.decrypt(
                    black_box(&ciphertext),
                    black_box(&nonce),
                    black_box(&tag),
                    black_box(timestamp),
                    black_box(ssrc),
                )
            });
        });
    }

    group.finish();
}

/// Benchmark control channel encryption (RTSP commands).
///
/// Less frequent than audio but still important for session management.
fn bench_control_encryption(c: &mut Criterion) {
    let mut group = c.benchmark_group("control_encryption");

    // RTSP requests are typically small (100-500 bytes)
    for size in [128, 512, 1024] {
        group.throughput(Throughput::Bytes(size as u64));

        let mut cipher = ControlCipher::new_unidirectional([0x42u8; 32]);
        let plaintext = vec![0xABu8; size];

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                cipher.encrypt(black_box(&plaintext))
            });
        });
    }

    group.finish();
}

/// Benchmark control channel decryption.
fn bench_control_decryption(c: &mut Criterion) {
    let mut group = c.benchmark_group("control_decryption");

    for size in [128, 512, 1024] {
        group.throughput(Throughput::Bytes(size as u64));

        let mut encrypt_cipher = ControlCipher::new_unidirectional([0x42u8; 32]);
        let mut decrypt_cipher = ControlCipher::new_unidirectional([0x42u8; 32]);
        let plaintext = vec![0xABu8; size];

        let ciphertext = encrypt_cipher.encrypt(&plaintext).unwrap();

        group.bench_with_input(BenchmarkId::from_parameter(size), &size, |b, _| {
            b.iter(|| {
                decrypt_cipher.decrypt(black_box(&ciphertext))
            });
        });
    }

    group.finish();
}

/// Benchmark realistic audio streaming scenario.
///
/// Simulates encrypting 1 second of audio (125 packets for 44.1kHz).
fn bench_audio_streaming_1sec(c: &mut Criterion) {
    c.bench_function("audio_streaming_1sec", |b| {
        let cipher = AudioCipher::new([0x42u8; 32]);
        let audio_packet = vec![0xABu8; 1024]; // ~1KB packet

        b.iter(|| {
            for seqnum in 0..125u16 {
                let _ = cipher.encrypt_with_seq(
                    black_box(&audio_packet),
                    black_box(44100 * seqnum as u32 / 125),
                    black_box(0xDEADBEEF),
                    black_box(seqnum),
                );
            }
        });
    });
}

criterion_group!(
    benches,
    bench_audio_encryption,
    bench_audio_decryption,
    bench_control_encryption,
    bench_control_decryption,
    bench_audio_streaming_1sec,
);

criterion_main!(benches);
