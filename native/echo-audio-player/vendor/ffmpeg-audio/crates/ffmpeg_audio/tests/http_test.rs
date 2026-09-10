#![cfg(feature = "http")]

use std::{
    io::{Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream},
    thread::{self, JoinHandle},
    time::Duration,
};

use ffmpeg_audio::{AudioReader, HttpAudioSource, SeekMode};
use tracing_subscriber::{EnvFilter, fmt};

fn request_range_start(stream: &mut TcpStream) -> usize {
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let size = stream.read(&mut chunk).expect("failed to read request");
        if size == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..size]);
    }
    let request = String::from_utf8_lossy(&request);
    request
        .lines()
        .find_map(|line| {
            line.strip_prefix("Range: bytes=")
                .or_else(|| line.strip_prefix("range: bytes="))
        })
        .and_then(|value| value.trim_end_matches('-').parse().ok())
        .unwrap_or_default()
}

fn write_range_response(stream: &mut TcpStream, data: &[u8], start: usize, body_len: usize) {
    let end = data.len() - 1;
    write!(
        stream,
        "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
        data.len() - start,
        start,
        end,
        data.len()
    )
    .expect("failed to write response headers");
    stream
        .write_all(&data[start..start + body_len])
        .expect("failed to write response body");
}

fn spawn_disconnect_server(data: Vec<u8>) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind mock server");
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let (mut initial, _) = listener.accept().expect("missing initial request");
        let start = request_range_start(&mut initial);
        let partial_len = (data.len() - start) / 3;
        write_range_response(&mut initial, &data, start, partial_len);
        drop(initial);

        let (mut reconnect, _) = listener.accept().expect("missing reconnect request");
        let start = request_range_start(&mut reconnect);
        let remaining = data.len() - start;
        write_range_response(&mut reconnect, &data, start, remaining);
    });
    (format!("http://{address}/audio.bin"), handle)
}

fn spawn_wrong_range_server(total_len: usize) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind mock server");
    let address = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        let data = vec![0u8; total_len];
        let (mut initial, _) = listener.accept().expect("missing initial request");
        let start = request_range_start(&mut initial);
        write_range_response(&mut initial, &data, start, 1);
        drop(initial);

        let (mut seek, _) = listener.accept().expect("missing seek request");
        let _requested_start = request_range_start(&mut seek);
        write_range_response(&mut seek, &data, 0, 1);
    });
    (format!("http://{address}/audio.bin"), handle)
}

#[test]
#[ignore = "Needs network connection"]
fn http_test() {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("debug")),
        )
        .try_init()
        .unwrap();

    let url = "http://127.0.0.1:8000/seek_test.aac";

    println!("Connecting to {url}...");
    let source = HttpAudioSource::new(url).expect("Failed to initialize HTTP source");

    let mut reader = AudioReader::new(source).expect("Failed to create AudioReader");

    let duration = reader.duration().unwrap();
    println!("Duration: {duration:?}");

    println!("Seeking to 10s...");
    reader
        .seek(Duration::from_secs(10), SeekMode::Accurate)
        .unwrap();

    println!("Reading some frames...");
    for _ in 0..5 {
        let frame = reader.receive_frame().unwrap();
        if frame.is_some() {
            println!("Successfully read a frame");
        }
    }
}

#[test]
fn http_recovers_exact_bytes_after_midstream_disconnect() {
    const FILE_SIZE: usize = 64 * 1024;
    let expected = (0..FILE_SIZE)
        .map(|index| (index % 256) as u8)
        .collect::<Vec<_>>();
    let (url, server) = spawn_disconnect_server(expected.clone());
    let mut source =
        HttpAudioSource::new(&url).expect("failed to initialize disconnecting HTTP source");
    let mut output = Vec::new();

    source
        .read_to_end(&mut output)
        .expect("HTTP source should reconnect and finish the stream");

    assert_eq!(output, expected);
    server.join().expect("disconnect mock server failed");
}

#[test]
fn http_rejects_out_of_order_content_range() {
    const FILE_SIZE: usize = 128 * 1024;
    const SEEK_TARGET: u64 = 96 * 1024;
    let (url, server) = spawn_wrong_range_server(FILE_SIZE);
    let mut source =
        HttpAudioSource::new(&url).expect("failed to initialize wrong-range HTTP source");

    let error = source
        .seek(SeekFrom::Start(SEEK_TARGET))
        .expect_err("mismatched Content-Range must be rejected");

    assert!(error.to_string().to_ascii_lowercase().contains("range"));
    server.join().expect("wrong-range mock server failed");
}
