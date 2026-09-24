//! Owns the AirPlay client on one thread and feeds it post-DSP PCM.
//! A timed-out send keeps the same frame. An older epoch is discarded.

use crate::bonjour;
use crate::pcm::{self, PcmFrame, TRANSPORT_FORMAT};
use airplay_client::{ClientBuilder, Device, LiveFrameSender, LivePcmFrame};
use std::io::{ErrorKind, Read};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc as async_mpsc;

const MAX_SAMPLES: usize = 65_536;
const TRANSPORT_RATE: u32 = 44_100;

pub fn discovery_backend() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "macos-dns-sd"
    }
    #[cfg(not(target_os = "macos"))]
    {
        "mdns-sd"
    }
}

#[derive(Debug, Clone)]
pub struct FoundDevice {
    pub id: String,
    pub name: String,
    pub model: String,
    pub addresses: Vec<String>,
    pub needs_pin: bool,
}

#[derive(Debug, Clone)]
pub struct Link {
    pub ok: bool,
    pub error: Option<String>,
    pub format: Option<String>,
    pub pcm_port: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct Status {
    pub connected: bool,
    pub delay_sec: f64,
    pub format: String,
    pub input_bits: u32,
    pub error: Option<String>,
    pub feeder_received_frames: u32,
    pub feeder_sent_frames: u32,
    pub feeder_send_errors: u32,
}

enum Command {
    Discover {
        timeout_ms: u32,
        progress: Option<Sender<FoundDevice>>,
        reply: Sender<Result<Vec<FoundDevice>, String>>,
    },
    Connect {
        id: String,
        pin: String,
        reply: Sender<Link>,
    },
    Disconnect {
        reply: Sender<()>,
    },
    Pause {
        reply: Sender<Result<(), String>>,
    },
    Resume {
        reply: Sender<Result<(), String>>,
    },
    Seek {
        seconds: f64,
        reply: Sender<Result<u32, String>>,
    },
    Stop {
        reply: Sender<Result<(), String>>,
    },
    Volume {
        volume: f64,
        reply: Sender<Result<(), String>>,
    },
    Flush {
        reply: Sender<Result<u32, String>>,
    },
    Status {
        reply: Sender<Status>,
    },
    Clear,
}

pub struct Session {
    tx: async_mpsc::Sender<Command>,
}

impl Session {
    pub fn start() -> Self {
        let (tx, mut rx) = async_mpsc::channel(8);
        let command_tx = tx.clone();
        thread::Builder::new()
            .name("airplay-session".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        eprintln!("[echo-airplay] runtime failed: {err}");
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut client = match ClientBuilder::new().render_delay_ms(200).build() {
                        Ok(client) => client,
                        Err(err) => {
                            refuse_until_closed(&mut rx, err.to_string()).await;
                            return;
                        }
                    };
                    let mut state = Worker::default();
                    while let Some(command) = rx.recv().await {
                        if !state.handle(&mut client, command).await {
                            break;
                        }
                    }
                    state.shutdown(&mut client).await;
                });
            })
            .ok();
        Self { tx: command_tx }
    }

    pub fn discover(&self, timeout_ms: u32) -> Result<Vec<FoundDevice>, String> {
        self.discover_with_progress(timeout_ms, None)
    }

    pub fn discover_with_progress(
        &self,
        timeout_ms: u32,
        progress: Option<Sender<FoundDevice>>,
    ) -> Result<Vec<FoundDevice>, String> {
        self.roundtrip(
            |reply| Command::Discover {
                timeout_ms,
                progress,
                reply,
            },
            Duration::from_secs(12),
        )?
    }

    pub fn connect(&self, id: String, pin: String) -> Result<Link, String> {
        self.roundtrip(
            |reply| Command::Connect { id, pin, reply },
            Duration::from_secs(20),
        )
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.roundtrip(
            |reply| Command::Disconnect { reply },
            Duration::from_secs(8),
        )
    }

    pub fn pause(&self) -> Result<(), String> {
        self.roundtrip(|reply| Command::Pause { reply }, Duration::from_secs(8))?
    }

    pub fn resume(&self) -> Result<(), String> {
        self.roundtrip(|reply| Command::Resume { reply }, Duration::from_secs(8))?
    }

    pub fn seek(&self, seconds: f64) -> Result<u32, String> {
        self.roundtrip(
            |reply| Command::Seek { seconds, reply },
            Duration::from_secs(8),
        )?
    }

    pub fn stop(&self) -> Result<(), String> {
        self.roundtrip(|reply| Command::Stop { reply }, Duration::from_secs(8))?
    }

    pub fn volume(&self, volume: f64) -> Result<(), String> {
        self.roundtrip(
            |reply| Command::Volume { volume, reply },
            Duration::from_secs(8),
        )?
    }

    pub fn flush(&self) -> Result<u32, String> {
        self.roundtrip(|reply| Command::Flush { reply }, Duration::from_secs(8))?
    }

    pub fn status(&self) -> Result<Status, String> {
        self.roundtrip(|reply| Command::Status { reply }, Duration::from_secs(2))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.tx
            .blocking_send(Command::Clear)
            .map_err(|_| "AirPlay 发送线程已退出".to_string())
    }

    fn roundtrip<T>(
        &self,
        command: impl FnOnce(Sender<T>) -> Command,
        timeout: Duration,
    ) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .blocking_send(command(reply_tx))
            .map_err(|_| "AirPlay 发送线程已退出".to_string())?;
        reply_rx
            .recv_timeout(timeout)
            .map_err(|_| "AirPlay 命令超时".to_string())
    }
}

async fn refuse_until_closed(rx: &mut async_mpsc::Receiver<Command>, error: String) {
    while let Some(command) = rx.recv().await {
        let message = error.clone();
        match command {
            Command::Discover { reply, .. } => {
                let _ = reply.send(Err(message));
            }
            Command::Connect { reply, .. } => {
                let _ = reply.send(Link {
                    ok: false,
                    error: Some(message),
                    format: None,
                    pcm_port: None,
                });
            }
            Command::Disconnect { reply } => {
                let _ = reply.send(());
            }
            Command::Pause { reply } | Command::Resume { reply } | Command::Stop { reply } => {
                let _ = reply.send(Err(message));
            }
            Command::Seek { reply, .. } | Command::Flush { reply } => {
                let _ = reply.send(Err(message));
            }
            Command::Volume { reply, .. } => {
                let _ = reply.send(Err(message));
            }
            Command::Status { reply } => {
                let _ = reply.send(Status {
                    connected: false,
                    delay_sec: 0.0,
                    format: TRANSPORT_FORMAT.to_string(),
                    input_bits: u32::from(pcm::INPUT_BITS),
                    error: Some(message),
                    feeder_received_frames: 0,
                    feeder_sent_frames: 0,
                    feeder_send_errors: 0,
                });
            }
            Command::Clear => {}
        }
    }
}

struct Feed {
    stop: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    stats: Arc<FeedStats>,
    sender: Arc<LiveFrameSender>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct FeedStats {
    received_frames: AtomicU64,
    sent_frames: AtomicU64,
    send_errors: AtomicU64,
}

#[derive(Default)]
struct Worker {
    devices: Vec<Device>,
    feed: Option<Feed>,
    epoch: u32,
    last_error: Option<String>,
    connected: bool,
}

impl Worker {
    async fn handle(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        command: Command,
    ) -> bool {
        match command {
            Command::Discover {
                timeout_ms,
                progress,
                reply,
            } => {
                let timeout = Duration::from_millis(timeout_ms.clamp(200, 8_000) as u64);
                let found = self.discover_devices(client, timeout, progress).await;
                let _ = reply.send(found);
            }
            Command::Connect { id, pin, reply } => {
                let _ = reply.send(self.connect(client, &id, &pin).await);
            }
            Command::Disconnect { reply } => {
                self.shutdown(client).await;
                let _ = reply.send(());
            }
            Command::Pause { reply } => {
                let _ = reply.send(self.transport(client.pause().await));
            }
            Command::Resume { reply } => {
                let _ = reply.send(self.transport(client.resume().await));
            }
            Command::Seek { seconds, reply } => {
                let _ = reply.send(self.seek(client, seconds).await);
            }
            Command::Stop { reply } => {
                let _ = reply.send(self.transport(client.stop().await));
            }
            Command::Volume { volume, reply } => {
                let level = (volume / 100.0).clamp(0.0, 1.0) as f32;
                let _ = reply.send(self.transport(client.set_volume(level).await));
            }
            Command::Flush { reply } => {
                let _ = reply.send(self.seek(client, 0.0).await);
            }
            Command::Status { reply } => {
                let _ = reply.send(self.status());
            }
            Command::Clear => {
                self.devices.clear();
                self.last_error = None;
            }
        }
        true
    }

    async fn connect(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        id: &str,
        pin: &str,
    ) -> Link {
        self.shutdown(client).await;
        let Some(device) = self.lookup(id).cloned() else {
            return fail("设备不在当前发现结果里");
        };
        if device.requires_password && pin.trim().is_empty() {
            let _ = client.start_pin_pairing(&device).await;
            return fail("pin-required");
        }
        let connected = if pin.trim().is_empty() {
            client.connect(&device).await
        } else {
            client.connect_with_pairing_pin(&device, pin.trim()).await
        };
        if let Err(err) = connected {
            let error = normalize_connect_error(&err.to_string());
            if error == "pin-required" {
                let _ = client.start_pin_pairing(&device).await;
            }
            self.last_error = Some(error);
            return fail(
                &self
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "连接失败".to_string()),
            );
        }
        let sender = match client.start_live_streaming(TRANSPORT_RATE, 2).await {
            Ok(sender) => sender,
            Err(err) => {
                self.last_error = Some(err.to_string());
                let _ = client.disconnect().await;
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "无法开始发送".to_string()),
                );
            }
        };
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(err) => {
                self.last_error = Some(err.to_string());
                let _ = client.stop().await;
                let _ = client.disconnect().await;
                return fail("无法打开本机音频出口");
            }
        };
        let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
        if port == 0 {
            return fail("无法打开本机音频出口");
        }
        let epoch = Arc::new(AtomicU64::new(1));
        let stats = Arc::new(FeedStats::default());
        self.epoch = 1;
        let stop = Arc::new(AtomicBool::new(false));
        let shared_sender = Arc::new(sender);
        let feeder_sender = Arc::clone(&shared_sender);
        let feeder_epoch = Arc::clone(&epoch);
        let feeder_stop = Arc::clone(&stop);
        let feeder_stats = Arc::clone(&stats);
        let handle = match thread::Builder::new()
            .name("airplay-feeder".to_string())
            .spawn(move || {
                feed_loop(
                    listener,
                    feeder_sender,
                    feeder_epoch,
                    feeder_stop,
                    feeder_stats,
                );
            }) {
            Ok(handle) => handle,
            Err(err) => {
                self.last_error = Some(err.to_string());
                return fail("无法启动音频发送");
            }
        };
        self.feed = Some(Feed {
            stop,
            epoch,
            stats,
            sender: shared_sender,
            handle,
        });
        self.connected = true;
        self.last_error = None;
        Link {
            ok: true,
            error: None,
            format: Some(TRANSPORT_FORMAT.to_string()),
            pcm_port: Some(u32::from(port)),
        }
    }

    async fn discover_devices(
        &mut self,
        _client: &airplay_client::AirPlayClient,
        timeout: Duration,
        progress: Option<Sender<FoundDevice>>,
    ) -> Result<Vec<FoundDevice>, String> {
        #[cfg(target_os = "macos")]
        {
            let progress_tx = progress.clone();
            let devices = bonjour::discover_with_progress(timeout, move |device| {
                if let Some(tx) = &progress_tx {
                    let _ = tx.send(found_device(&device));
                }
            })
            .await;
            let listed = devices.iter().map(found_device).collect();
            self.devices = devices;
            Ok(listed)
        }

        #[cfg(not(target_os = "macos"))]
        {
            let devices = browse_devices(timeout, progress).await?;
            let listed = devices.iter().map(found_device).collect();
            self.devices = devices;
            Ok(listed)
        }
    }

    async fn seek(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        seconds: f64,
    ) -> Result<u32, String> {
        self.epoch = self.epoch.wrapping_add(1).max(1);
        if let Some(feed) = &self.feed {
            feed.epoch.store(u64::from(self.epoch), Ordering::Release);
            let position = (seconds.max(0.0) * f64::from(TRANSPORT_RATE)) as u64;
            feed.sender.signal_seek(position);
        }
        if self.connected {
            client.seek(seconds.max(0.0)).await.map_err(|err| {
                self.last_error = Some(err.to_string());
                err.to_string()
            })?;
        }
        Ok(self.epoch)
    }

    fn transport<T>(&mut self, result: Result<T, airplay_client::Error>) -> Result<(), String> {
        result.map(|_| ()).map_err(|err| {
            self.last_error = Some(err.to_string());
            err.to_string()
        })
    }

    fn lookup(&self, id: &str) -> Option<&Device> {
        let wanted = normalize_id(id);
        self.devices
            .iter()
            .find(|device| device_id(device) == id || normalize_id(&device_id(device)) == wanted)
    }

    fn status(&self) -> Status {
        let (feeder_received_frames, feeder_sent_frames, feeder_send_errors) =
            self.feed.as_ref().map(feed_stats).unwrap_or((0, 0, 0));
        Status {
            connected: self.connected,
            delay_sec: if self.connected { 0.2 } else { 0.0 },
            format: TRANSPORT_FORMAT.to_string(),
            input_bits: u32::from(pcm::INPUT_BITS),
            error: self.last_error.clone(),
            feeder_received_frames,
            feeder_sent_frames,
            feeder_send_errors,
        }
    }

    async fn shutdown(&mut self, client: &mut airplay_client::AirPlayClient) {
        if let Some(feed) = self.feed.take() {
            feed.stop.store(true, Ordering::Release);
            let _ = feed.handle.join();
        }
        if self.connected {
            let _ = client.stop().await;
            let _ = client.disconnect().await;
        }
        self.connected = false;
    }
}

fn fail(error: &str) -> Link {
    Link {
        ok: false,
        error: Some(error.to_string()),
        format: None,
        pcm_port: None,
    }
}

fn normalize_connect_error(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("invalid pin")
        || lower.contains("srp verification failed")
        || lower.contains("verification failed")
    {
        return "pin-invalid".to_string();
    }
    if lower.contains("requires password")
        || lower.contains("401")
        || lower.contains("unauthorized")
        || lower.contains("pair-pin")
    {
        return "pin-required".to_string();
    }
    if lower.contains("pairing rejected") || lower.contains("unexpected status code: 403") {
        return "airplay-permission-required".to_string();
    }
    if lower.contains("mfi") {
        return "airplay-mfi-required".to_string();
    }
    error.to_string()
}

fn found_device(device: &Device) -> FoundDevice {
    FoundDevice {
        id: device_id(device),
        name: device.name.clone(),
        model: device.model.clone(),
        addresses: device
            .addresses
            .iter()
            .map(|address| address.to_string())
            .collect(),
        needs_pin: device.requires_password,
    }
}

fn device_id(device: &Device) -> String {
    device.id.to_mac_string()
}

#[cfg(not(target_os = "macos"))]
async fn browse_devices(
    timeout: Duration,
    progress: Option<Sender<FoundDevice>>,
) -> Result<Vec<Device>, String> {
    use airplay_client::Discovery;
    use airplay_discovery::{BrowseEvent, ServiceBrowser};
    use std::collections::HashMap;
    use tokio_stream::StreamExt;

    let browser = ServiceBrowser::new().map_err(|err| err.to_string())?;
    let mut stream = browser.browse().await.map_err(|err| err.to_string())?;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    let mut devices = HashMap::new();
    loop {
        tokio::select! {
            _ = &mut deadline => break,
            event = stream.next() => {
                let Some(event) = event else {
                    break;
                };
                match event {
                    BrowseEvent::Added(device) | BrowseEvent::Updated(device) => {
                        devices.insert(device.id.clone(), device.clone());
                        if let Some(tx) = &progress {
                            let _ = tx.send(found_device(&device));
                        }
                    }
                    BrowseEvent::Removed(id) => {
                        devices.remove(&id);
                    }
                }
            }
        }
    }
    browser.stop().await;
    Ok(devices.into_values().collect())
}

fn normalize_id(id: &str) -> String {
    id.chars()
        .filter(|ch| ch.is_ascii_hexdigit())
        .map(|ch| ch.to_ascii_lowercase())
        .collect()
}

fn feed_loop(
    listener: TcpListener,
    sender: Arc<LiveFrameSender>,
    epoch: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    stats: Arc<FeedStats>,
) {
    listener.set_nonblocking(true).ok();
    let mut stream: Option<TcpStream> = None;
    let mut buffer = Vec::new();
    let mut pending: Option<PcmFrame> = None;
    while !stop.load(Ordering::Acquire) {
        if stream.is_none() {
            match listener.accept() {
                Ok((socket, address)) => {
                    if address.ip().is_loopback() {
                        socket.set_nodelay(true).ok();
                        socket
                            .set_read_timeout(Some(Duration::from_millis(50)))
                            .ok();
                        let _ = socket.set_nonblocking(false);
                        stream = Some(socket);
                        buffer.clear();
                    }
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => thread::sleep(Duration::from_millis(20)),
            }
            continue;
        }
        if pending.is_none() {
            match read_frame(stream.as_mut().unwrap(), &mut buffer) {
                Ok(Some(frame)) => {
                    stats.received_frames.fetch_add(1, Ordering::Relaxed);
                    pending = Some(frame);
                }
                Ok(None) => {}
                Err(_) => {
                    stream = None;
                    buffer.clear();
                    pending = None;
                }
            }
        }
        let Some(frame) = pending.clone() else {
            continue;
        };
        if frame.epoch != epoch.load(Ordering::Acquire) {
            pending = None;
            continue;
        }
        let live = LivePcmFrame {
            samples: pcm::resample_stereo_i16(&frame.samples, frame.sample_rate, TRANSPORT_RATE),
            channels: 2,
            sample_rate: TRANSPORT_RATE,
        };
        match sender.send_timeout(live, Duration::from_millis(200)) {
            Ok(()) => {
                stats.sent_frames.fetch_add(1, Ordering::Relaxed);
                pending = None;
            }
            Err(err) => {
                stats.send_errors.fetch_add(1, Ordering::Relaxed);
                let disconnected = format!("{err:?}").contains("Disconnected");
                if disconnected || stop.load(Ordering::Acquire) {
                    break;
                }
            }
        }
    }
}

fn feed_stats(feed: &Feed) -> (u32, u32, u32) {
    (
        feed.stats
            .received_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        feed.stats
            .sent_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        feed.stats
            .send_errors
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
    )
}

fn read_frame(stream: &mut TcpStream, buffer: &mut Vec<u8>) -> std::io::Result<Option<PcmFrame>> {
    let mut chunk = [0u8; 8192];
    match stream.read(&mut chunk) {
        Ok(0) => return Err(std::io::Error::new(ErrorKind::UnexpectedEof, "closed")),
        Ok(size) => buffer.extend_from_slice(&chunk[..size]),
        Err(err) if err.kind() == ErrorKind::WouldBlock || err.kind() == ErrorKind::TimedOut => {}
        Err(err) => return Err(err),
    }
    if buffer.len() < 18 {
        return Ok(None);
    }
    let count = u32::from_le_bytes(buffer[14..18].try_into().unwrap_or([0; 4])) as usize;
    if count == 0 || count > MAX_SAMPLES {
        buffer.clear();
        return Err(std::io::Error::new(ErrorKind::InvalidData, "frame"));
    }
    let total = 18 + count * 2;
    if buffer.len() < total {
        return Ok(None);
    }
    let frame = pcm::decode_frame(&buffer[..total]);
    buffer.drain(..total);
    Ok(frame)
}
