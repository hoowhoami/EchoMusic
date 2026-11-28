//! 本地滚动 m3u8 与真实 AAC/TS fixtures；不依赖音频设备或公网电台。
//! 移植自 EchoMusicNext 的 hls_tests，适配本 crate 的 DecoderData::open 签名
//! （多一个 mix_sample_rate 入参）与 fixture 路径布局。
use super::decoder::DecoderData;
use super::stream::StreamOptions;
use ffmpeg_audio::PacketCacheOptions;
use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(rolling: bool, format: &'static str, broken: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/hls");
        let worker = thread::spawn(move || {
            let started = Instant::now();
            while !stopped.load(Ordering::Acquire) {
                let Ok((mut stream, _)) = listener.accept() else {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                };
                // Windows 上 accept 的 socket 继承监听 socket 的非阻塞属性；
                // 恢复阻塞模式，避免半截请求头破坏路径解析。
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                while request.len() < 8192 && !request.ends_with(b"\r\n\r\n") {
                    let mut part = [0u8; 1024];
                    match stream.read(&mut part) {
                        Ok(0) | Err(_) => break,
                        Ok(count) => request.extend_from_slice(&part[..count]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                seen.lock().unwrap().push(path.clone());
                let (mut status, extra, mut body) = if path == "/redirect" {
                    (
                        "302 Found",
                        if format == "master" {
                            "Location: /radio/master.m3u8\r\n"
                        } else {
                            "Location: /radio/live.m3u8\r\n"
                        },
                        Vec::new(),
                    )
                } else if path == "/radio/master.m3u8" {
                    ("200 OK", "Content-Type: application/vnd.apple.mpegurl\r\n",
                        b"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=40000,CODECS=\"mp4a.40.2\"\nlive.m3u8\n".to_vec())
                } else if path == "/radio/live.m3u8" {
                    let manifest = if broken {
                        "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nmissing.ts\n".to_string()
                    } else if rolling {
                        let published = (3 + started.elapsed().as_millis() as usize / 500).min(11);
                        let first = published.saturating_sub(3);
                        let mut text = format!(
                            "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:{first}\n"
                        );
                        for i in first..published {
                            text += &format!("#EXTINF:1.0,\ns{i}.ts\n");
                        }
                        text
                    } else {
                        std::fs::read_to_string(root.join(match format {
                            "fmp4" => "fmp4.m3u8",
                            "range" => "range.m3u8",
                            _ => "vod.m3u8",
                        }))
                        .unwrap()
                    };
                    (
                        "200 OK",
                        "Content-Type: application/vnd.apple.mpegurl\r\n",
                        manifest.into_bytes(),
                    )
                } else if let Some(file) = path.strip_prefix("/radio/") {
                    match std::fs::read(root.join(file)) {
                        Ok(body) => ("200 OK", "", body),
                        Err(_) => ("404 Not Found", "", Vec::new()),
                    }
                } else {
                    ("404 Not Found", "", Vec::new())
                };
                let mut extra = extra.to_string();
                if !path.ends_with(".m3u8") && !body.is_empty() {
                    if let Some(range) = request
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("range"))
                                .map(|(_, value)| value.trim())
                        })
                        .and_then(|value| value.strip_prefix("bytes="))
                    {
                        let (start, end) = range.split_once('-').unwrap();
                        let start: usize = start.parse().unwrap();
                        let total = body.len();
                        let end: usize = if end.is_empty() {
                            total - 1
                        } else {
                            end.parse().unwrap()
                        };
                        if start < total && end < total && end >= start {
                            extra += &format!("Content-Range: bytes {start}-{end}/{total}\r\n");
                            body = body[start..=end].to_vec();
                            status = "206 Partial Content";
                        }
                    }
                }
                let header = format!(
                    "HTTP/1.1 {status}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(worker),
        }
    }
    fn decoder(&self, flag: Arc<AtomicBool>) -> Result<DecoderData, String> {
        DecoderData::open(
            format!("{}/redirect", self.url),
            None,
            None,
            flag,
            PacketCacheOptions::default(),
            &StreamOptions {
                network_timeout: Duration::from_secs(2),
                ..Default::default()
            },
        )
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.thread.take().unwrap().join().unwrap();
    }
}

#[test]
fn rolling_hls_decodes_new_relative_segments_and_cancels_without_eof() {
    let server = Server::new(true, "ts", false);
    let flag = Arc::new(AtomicBool::new(false));
    let mut decoder = server.decoder(flag.clone()).unwrap();
    assert!(decoder.is_live());
    assert!(decoder.seek(1.0).is_err());
    let chunks = decoder.predecode_chunks(6.0).unwrap();
    assert!(chunks.iter().map(|v| v.frames).sum::<usize>() > 240_000);
    assert!(
        chunks.iter().any(|chunk| match &chunk.data {
            super::shared::DecodedAudioData::F32(samples) =>
                samples.iter().any(|value| value.abs() > 0.001),
            super::shared::DecodedAudioData::I16(samples) => samples.iter().any(|value| value.abs() > 32),
            _ => false,
        }),
        "decoded PCM must contain the synthetic tone"
    );
    let paths = server.requests.lock().unwrap().clone();
    assert!(
        paths
            .iter()
            .filter(|path| *path == "/radio/live.m3u8")
            .count()
            > 2,
        "{paths:?}"
    );
    assert!(paths.iter().any(|path| path == "/radio/s4.ts"), "{paths:?}");
    flag.store(true, Ordering::Release);
    let start = Instant::now();
    drop(decoder);
    assert!(start.elapsed() < Duration::from_secs(1));
    let count = server.requests.lock().unwrap().len();
    thread::sleep(Duration::from_millis(150));
    assert_eq!(count, server.requests.lock().unwrap().len());
}

#[test]
fn finite_hls_ts_and_fmp4_decode_to_eof() {
    for format in ["ts", "fmp4", "range", "master"] {
        let server = Server::new(false, format, false);
        let flag = Arc::new(AtomicBool::new(false));
        let mut decoder = server.decoder(flag.clone()).unwrap();
        assert!(!decoder.is_live());
        let mut frames = 0;
        while let Some(chunk) = decoder.decode_next_chunk().unwrap() {
            frames += chunk.frames;
        }
        assert!(
            frames
                >= if matches!(format, "ts" | "master") {
                    520_000
                } else {
                    260_000
                },
            "{frames}"
        );
        flag.store(true, Ordering::Release);
    }
}

#[test]
fn broken_hls_is_a_decoder_error() {
    let server = Server::new(false, "ts", true);
    let started = Instant::now();
    assert!(server.decoder(Arc::new(AtomicBool::new(false))).is_err());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn ordinary_mp3_and_aac_keep_the_existing_http_decoder_path() {
    let server = Server::new(false, "ts", false);
    for extension in ["mp3", "aac"] {
        let flag = Arc::new(AtomicBool::new(false));
        let mut decoder = DecoderData::open(
            format!("{}/radio/direct.{extension}", server.url),
            None,
            None,
            flag.clone(),
            PacketCacheOptions::default(),
            &StreamOptions {
                network_timeout: Duration::from_secs(2),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!decoder.is_live());
        assert!(decoder.capabilities().seekable);
        let mut frames = 0;
        while let Some(chunk) = decoder.decode_next_chunk().unwrap() {
            frames += chunk.frames;
        }
        assert!(frames > 85_000, "{extension}: {frames}");
        flag.store(true, Ordering::Release);
    }
}
