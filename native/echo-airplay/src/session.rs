//! Owns the AirPlay client on one thread and feeds it post-DSP PCM.
//! A timed-out send keeps the same frame. An older epoch is discarded.

use crate::bonjour;
use crate::pcm::{self, PcmFrame, TRANSPORT_FORMAT};
use airplay_audio::AlacEncoder;
use airplay_client::{
    ClientBuilder, Device, LiveAudioDecoder, LiveFrameSender, LivePcmFrame, RaopConnection,
};
use airplay_core::{AudioFormat, PtpMode, StreamConfig, StreamType, TimingProtocol};
use airplay_discovery::TxtRecordParser;
use std::io::{ErrorKind, Read};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tokio::sync::mpsc as async_mpsc;

const MAX_SAMPLES: usize = 65_536;
const TRANSPORT_RATE: u32 = 44_100;
const DISCOVER_MIN_TIMEOUT_MS: u32 = 200;
const DISCOVER_MAX_TIMEOUT_MS: u32 = 8_000;
const LIVE_PCM_CAPACITY: usize = 16;
const CONNECT_ACCEPT_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_RESULT_TIMEOUT: Duration = Duration::from_secs(60);

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
    pub supports_airplay2: bool,
    pub supports_raop: bool,
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
    Connect {
        id: String,
        pin: String,
        initial_volume: f32,
        accepted: Sender<()>,
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
    Clear,
}

pub struct Session {
    tx: Mutex<async_mpsc::Sender<Command>>,
    status: SharedStatus,
    devices: DeviceCache,
}

impl Session {
    pub fn start() -> Self {
        let status = new_status_mirror();
        let devices = new_device_cache();
        let tx = spawn_worker(Arc::clone(&status), Arc::clone(&devices));
        Self {
            tx: Mutex::new(tx),
            status,
            devices,
        }
    }

    fn restart_worker(&self, reason: &str) {
        echo_native_log::warn(format!("AirPlay native worker 重启: reason={reason}"));
        update_status(&self.status, |status| {
            status.connected = false;
            status.error = Some(format!("AirPlay native worker 已重启: {reason}"));
            status.feed_stats = None;
        });
        let tx = spawn_worker(Arc::clone(&self.status), Arc::clone(&self.devices));
        if let Ok(mut guard) = self.tx.lock() {
            *guard = tx;
        }
    }

    fn command_tx(&self) -> Result<async_mpsc::Sender<Command>, String> {
        self.tx
            .lock()
            .map(|guard| guard.clone())
            .map_err(|err| format!("AirPlay worker 锁定失败: {err}"))
    }
}

fn spawn_worker(status: SharedStatus, devices: DeviceCache) -> async_mpsc::Sender<Command> {
    let (tx, mut rx) = async_mpsc::channel(8);
    let command_tx = tx.clone();
    let worker_status = Arc::clone(&status);
    let worker_devices = Arc::clone(&devices);
    thread::Builder::new()
        .name("airplay-session".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    echo_native_log::error(format!("AirPlay runtime 启动失败: {err}"));
                    return;
                }
            };
            runtime.block_on(async move {
                let mut client = match ClientBuilder::new().render_delay_ms(200).build() {
                    Ok(client) => client,
                    Err(err) => {
                        update_status(&worker_status, |status| {
                            status.connected = false;
                            status.error = Some(err.to_string());
                            status.feed_stats = None;
                        });
                        refuse_until_closed(&mut rx, err.to_string()).await;
                        return;
                    }
                };
                let mut state = Worker::new(worker_status, worker_devices);
                while let Some(command) = rx.recv().await {
                    if !state.handle(&mut client, command).await {
                        break;
                    }
                }
                state.shutdown(&mut client).await;
            });
        })
        .ok();
    command_tx
}

impl Session {
    pub fn discover(&self, timeout_ms: u32) -> Result<Vec<FoundDevice>, String> {
        self.discover_with_progress(timeout_ms, None)
    }

    pub fn discover_with_progress(
        &self,
        timeout_ms: u32,
        progress: Option<Sender<FoundDevice>>,
    ) -> Result<Vec<FoundDevice>, String> {
        let timeout = Duration::from_millis(
            timeout_ms.clamp(DISCOVER_MIN_TIMEOUT_MS, DISCOVER_MAX_TIMEOUT_MS) as u64,
        );
        discover_devices(timeout, progress, &self.devices)
    }

    pub fn connect(
        &self,
        id: String,
        pin: String,
        initial_volume: Option<f64>,
    ) -> Result<Link, String> {
        let initial_volume = clamp_volume(initial_volume.unwrap_or(50.0));
        update_status(&self.status, |status| {
            status.connected = false;
            status.delay_sec = 0.0;
            status.error = Some("AirPlay CONNECT 已提交，等待 native worker".to_string());
            status.feed_stats = None;
        });
        echo_native_log::info(format!(
            "AirPlay native CONNECT 已提交: id={id}, pin={}, initialVolume={:.0}%",
            if pin.trim().is_empty() { "no" } else { "yes" },
            initial_volume * 100.0
        ));
        let result = self.connect_roundtrip(id, pin, initial_volume);
        if let Err(error) = &result {
            update_status(&self.status, |status| {
                status.connected = false;
                status.error = Some(format!("AirPlay CONNECT 等待结果失败: {error}"));
                status.feed_stats = None;
            });
            echo_native_log::warn(format!("AirPlay native CONNECT 等待结果失败: {error}"));
        }
        result
    }

    fn connect_roundtrip(
        &self,
        id: String,
        pin: String,
        initial_volume: f32,
    ) -> Result<Link, String> {
        let mut last_error = "AirPlay 命令超时".to_string();
        for attempt in 1..=2 {
            let (reply_tx, reply_rx) = mpsc::channel();
            let (accepted_tx, accepted_rx) = mpsc::channel();
            self.command_tx()?
                .blocking_send(Command::Connect {
                    id: id.clone(),
                    pin: pin.clone(),
                    initial_volume,
                    accepted: accepted_tx,
                    reply: reply_tx,
                })
                .map_err(|_| "AirPlay 发送线程已退出".to_string())?;

            if accepted_rx.recv_timeout(CONNECT_ACCEPT_TIMEOUT).is_err() {
                last_error = "AirPlay CONNECT 未被 native worker 接收".to_string();
                echo_native_log::warn(format!(
                    "AirPlay native CONNECT 未被 worker 接收，准备重启: id={id}, attempt={attempt}"
                ));
                self.restart_worker("connect-not-accepted");
                continue;
            }

            return match reply_rx.recv_timeout(CONNECT_RESULT_TIMEOUT) {
                Ok(reply) => Ok(reply),
                Err(_) => {
                    self.restart_worker("connect-timeout");
                    Err("AirPlay 命令超时".to_string())
                }
            };
        }
        Err(last_error)
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
        Ok(snapshot_status(&self.status))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.command_tx()?
            .blocking_send(Command::Clear)
            .map_err(|_| "AirPlay 发送线程已退出".to_string())
    }

    fn roundtrip<T>(
        &self,
        command: impl FnOnce(Sender<T>) -> Command,
        timeout: Duration,
    ) -> Result<T, String> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.command_tx()?
            .blocking_send(command(reply_tx))
            .map_err(|_| "AirPlay 发送线程已退出".to_string())?;
        match reply_rx.recv_timeout(timeout) {
            Ok(reply) => Ok(reply),
            Err(_) => {
                self.restart_worker("command-timeout");
                Err("AirPlay 命令超时".to_string())
            }
        }
    }
}

async fn refuse_until_closed(rx: &mut async_mpsc::Receiver<Command>, error: String) {
    while let Some(command) = rx.recv().await {
        let message = error.clone();
        match command {
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
            Command::Clear => {}
        }
    }
}

struct Feed {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    sender: Arc<LiveFrameSender>,
    handle: JoinHandle<()>,
}

#[derive(Default)]
struct FeedStats {
    received_frames: AtomicU64,
    sent_frames: AtomicU64,
    send_errors: AtomicU64,
}

type SharedStatus = Arc<Mutex<StatusMirror>>;
type DeviceCache = Arc<Mutex<Vec<Device>>>;

#[derive(Clone)]
struct StatusMirror {
    connected: bool,
    delay_sec: f64,
    format: String,
    input_bits: u32,
    error: Option<String>,
    feed_stats: Option<Arc<FeedStats>>,
}

impl Default for StatusMirror {
    fn default() -> Self {
        Self {
            connected: false,
            delay_sec: 0.0,
            format: TRANSPORT_FORMAT.to_string(),
            input_bits: u32::from(pcm::INPUT_BITS),
            error: None,
            feed_stats: None,
        }
    }
}

fn new_status_mirror() -> SharedStatus {
    Arc::new(Mutex::new(StatusMirror::default()))
}

fn update_status(status: &SharedStatus, update: impl FnOnce(&mut StatusMirror)) {
    if let Ok(mut guard) = status.lock() {
        update(&mut guard);
    }
}

fn snapshot_status(status: &SharedStatus) -> Status {
    let mirror = status.try_lock().ok().map(|guard| guard.clone());
    let Some(mirror) = mirror else {
        return Status {
            connected: false,
            delay_sec: 0.0,
            format: TRANSPORT_FORMAT.to_string(),
            input_bits: u32::from(pcm::INPUT_BITS),
            error: Some("AirPlay 状态正在更新".to_string()),
            feeder_received_frames: 0,
            feeder_sent_frames: 0,
            feeder_send_errors: 0,
        };
    };
    let (feeder_received_frames, feeder_sent_frames, feeder_send_errors) = mirror
        .feed_stats
        .as_ref()
        .map(feed_stats_from_arc)
        .unwrap_or((0, 0, 0));
    Status {
        connected: mirror.connected,
        delay_sec: mirror.delay_sec,
        format: mirror.format,
        input_bits: mirror.input_bits,
        error: mirror.error,
        feeder_received_frames,
        feeder_sent_frames,
        feeder_send_errors,
    }
}

fn new_device_cache() -> DeviceCache {
    Arc::new(Mutex::new(Vec::new()))
}

fn replace_device_cache(cache: &DeviceCache, devices: Vec<Device>) {
    if let Ok(mut guard) = cache.lock() {
        *guard = devices;
    }
}

fn upsert_device_cache(cache: &DeviceCache, device: Device) {
    if let Ok(mut guard) = cache.lock() {
        let id = device_id(&device);
        if let Some(existing) = guard.iter_mut().find(|entry| device_id(entry) == id) {
            *existing = merge_device(existing, &device);
        } else {
            guard.push(device);
        }
    }
}

fn cached_devices(cache: &DeviceCache) -> Vec<Device> {
    cache.lock().map(|guard| guard.clone()).unwrap_or_default()
}

fn merge_device(existing: &Device, incoming: &Device) -> Device {
    if incoming.raop_port.is_some() && existing.raop_port.is_none() {
        return TxtRecordParser::merge_device_info(existing, incoming);
    }
    if existing.raop_port.is_some() && incoming.raop_port.is_none() {
        return TxtRecordParser::merge_device_info(incoming, existing);
    }
    let mut merged = existing.clone();
    for address in &incoming.addresses {
        if !merged.addresses.contains(address) {
            merged.addresses.push(*address);
        }
    }
    if merged.model.is_empty() {
        merged.model = incoming.model.clone();
    }
    if merged.public_key.is_none() {
        merged.public_key = incoming.public_key;
    }
    if merged.raop_port.is_none() {
        merged.raop_port = incoming.raop_port;
    }
    merged
}

struct Worker {
    devices: DeviceCache,
    feed: Option<Feed>,
    raop: Option<RaopConnection>,
    epoch: u32,
    last_error: Option<String>,
    connected: bool,
    status: SharedStatus,
}

impl Worker {
    fn new(status: SharedStatus, devices: DeviceCache) -> Self {
        Self {
            devices,
            feed: None,
            raop: None,
            epoch: 0,
            last_error: None,
            connected: false,
            status,
        }
    }

    fn update_status(&self, update: impl FnOnce(&mut StatusMirror)) {
        update_status(&self.status, update);
    }

    fn set_phase(&self, phase: impl Into<String>) {
        let phase = phase.into();
        self.update_status(|status| {
            status.connected = false;
            status.delay_sec = 0.0;
            status.error = Some(phase);
            status.feed_stats = None;
        });
    }

    async fn handle(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        command: Command,
    ) -> bool {
        match command {
            Command::Connect {
                id,
                pin,
                initial_volume,
                accepted,
                reply,
            } => {
                let _ = accepted.send(());
                self.set_phase(format!("AirPlay CONNECT 已接收: {id}"));
                echo_native_log::info(format!(
                    "AirPlay native CONNECT 已接收: id={id}, pin={}, initialVolume={:.0}%",
                    if pin.trim().is_empty() { "no" } else { "yes" },
                    initial_volume * 100.0
                ));
                let _ = reply.send(self.connect(client, &id, &pin, initial_volume).await);
            }
            Command::Disconnect { reply } => {
                self.shutdown(client).await;
                let _ = reply.send(());
            }
            Command::Pause { reply } => {
                let _ = reply.send(self.pause(client).await);
            }
            Command::Resume { reply } => {
                let _ = reply.send(self.resume(client).await);
            }
            Command::Seek { seconds, reply } => {
                let _ = reply.send(self.seek(client, seconds).await);
            }
            Command::Stop { reply } => {
                let _ = reply.send(self.stop(client).await);
            }
            Command::Volume { volume, reply } => {
                let level = (volume / 100.0).clamp(0.0, 1.0) as f32;
                let _ = reply.send(self.volume(client, level).await);
            }
            Command::Flush { reply } => {
                let _ = reply.send(self.seek(client, 0.0).await);
            }
            Command::Clear => {
                replace_device_cache(&self.devices, Vec::new());
                self.last_error = None;
                self.update_status(|status| {
                    status.error = None;
                });
            }
        }
        true
    }

    async fn connect(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        id: &str,
        pin: &str,
        initial_volume: f32,
    ) -> Link {
        self.shutdown(client).await;
        let Some(device) = self.lookup(id) else {
            return fail("设备不在当前发现结果里");
        };
        if device.supports_raop() && !device.supports_airplay2() {
            return self.connect_raop(device, pin, initial_volume).await;
        }
        self.set_phase(format!("AirPlay 2 CONNECT 中: {}", device.name));
        if device.requires_password && pin.trim().is_empty() {
            let _ = client.start_pin_pairing(&device).await;
            self.update_status(|status| {
                status.error = Some("pin-required".to_string());
            });
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
            let last_error = self.last_error.clone();
            self.update_status(|status| {
                status.connected = false;
                status.error = last_error;
                status.feed_stats = None;
            });
            return fail(
                &self
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "连接失败".to_string()),
            );
        }
        if let Err(err) = client.set_volume(initial_volume).await {
            echo_native_log::warn(format!("AirPlay 2 初始音量设置失败: {err}"));
        }
        let sender = match client.start_live_streaming(TRANSPORT_RATE, 2).await {
            Ok(sender) => sender,
            Err(err) => {
                self.last_error = Some(err.to_string());
                let _ = client.disconnect().await;
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "无法开始发送".to_string()),
                );
            }
        };
        let port = match self.attach_feeder(sender) {
            Ok(port) => port,
            Err(message) => {
                let _ = client.stop().await;
                let _ = client.disconnect().await;
                return fail(&message);
            }
        };
        Link {
            ok: true,
            error: None,
            format: Some(TRANSPORT_FORMAT.to_string()),
            pcm_port: Some(u32::from(port)),
        }
    }

    async fn connect_raop(&mut self, device: Device, pin: &str, initial_volume: f32) -> Link {
        if device.requires_password && pin.trim().is_empty() {
            return fail("pin-required");
        }

        let device_name = device.name.clone();
        let device_id = device_id(&device);
        let addresses = device
            .addresses
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("/");
        let audio_format = AudioFormat::default();
        let asc = match AlacEncoder::new(audio_format.clone()) {
            Ok(encoder) => Some(encoder.magic_cookie()),
            Err(err) => {
                self.last_error = Some(err.to_string());
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                return fail("无法构造 ALAC 配置");
            }
        };
        let config = StreamConfig {
            stream_type: StreamType::Realtime,
            audio_format,
            timing_protocol: TimingProtocol::Ntp,
            ptp_mode: PtpMode::Master,
            latency_min: 22_050,
            latency_max: 88_200,
            supports_dynamic_stream_id: true,
            asc,
        };
        let password = pin.trim().to_string();
        let pin_state = if password.is_empty() { "no" } else { "yes" };
        self.set_phase(format!("AirPlay 1 CONNECT 中: {device_name}"));
        echo_native_log::info(format!(
            "AirPlay 1 native CONNECT 开始: name={device_name}, id={device_id}, addresses={addresses}, pin={pin_state}",
        ));
        let mut connection = match tokio::time::timeout(Duration::from_secs(12), async move {
            if password.is_empty() {
                RaopConnection::connect(device, config).await
            } else {
                RaopConnection::connect_with_password(device, config, &password).await
            }
        })
        .await
        {
            Ok(Ok(connection)) => {
                echo_native_log::info(format!(
                    "AirPlay 1 native CONNECT 完成: name={device_name}, id={device_id}"
                ));
                connection
            }
            Ok(Err(err)) => {
                let error = normalize_connect_error(&err.to_string());
                self.last_error = Some(match error.as_str() {
                    "pin-required"
                    | "pin-invalid"
                    | "airplay-permission-required"
                    | "airplay-mfi-required" => error,
                    _ => format!("AirPlay 1 连接失败: {error}"),
                });
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                echo_native_log::warn(format!(
                    "AirPlay 1 native CONNECT 失败: name={device_name}, id={device_id}, error={}",
                    self.last_error.as_deref().unwrap_or("连接失败")
                ));
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "连接失败".to_string()),
                );
            }
            Err(_) => {
                self.last_error = Some(format!("AirPlay 1 连接超时: {device_name}"));
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                echo_native_log::warn(format!(
                    "AirPlay 1 native CONNECT 超时: name={device_name}, id={device_id}"
                ));
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "AirPlay 1 连接超时".to_string()),
                );
            }
        };

        if let Err(err) = connection.set_volume(initial_volume).await {
            echo_native_log::warn(format!(
                "AirPlay 1 初始音量设置失败: name={device_name}, id={device_id}, error={err}"
            ));
        }
        let (sender, decoder) = LiveAudioDecoder::create_pair(TRANSPORT_RATE, 2, LIVE_PCM_CAPACITY);
        self.set_phase(format!("AirPlay 1 START_LIVE 中: {device_name}"));
        echo_native_log::info(format!(
            "AirPlay 1 native START_LIVE 开始: name={device_name}, id={device_id}"
        ));
        match tokio::time::timeout(
            Duration::from_secs(4),
            connection.start_streaming_live(decoder),
        )
        .await
        {
            Ok(Ok(())) => {
                echo_native_log::info(format!(
                    "AirPlay 1 native START_LIVE 完成: name={device_name}, id={device_id}"
                ));
            }
            Ok(Err(err)) => {
                self.last_error = Some(format!("AirPlay 1 START_LIVE 失败: {err}"));
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                echo_native_log::warn(
                    format!(
                        "AirPlay 1 native START_LIVE 失败: name={device_name}, id={device_id}, error={err}"
                    ),
                );
                let _ = connection.disconnect().await;
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "无法开始发送".to_string()),
                );
            }
            Err(_) => {
                self.last_error = Some(format!("AirPlay 1 START_LIVE 超时: {device_name}"));
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                echo_native_log::warn(format!(
                    "AirPlay 1 native START_LIVE 超时: name={device_name}, id={device_id}"
                ));
                let _ = connection.disconnect().await;
                return fail(
                    &self
                        .last_error
                        .clone()
                        .unwrap_or_else(|| "AirPlay 1 START_LIVE 超时".to_string()),
                );
            }
        }

        let port = match self.attach_feeder(sender) {
            Ok(port) => port,
            Err(message) => {
                let _ = connection.disconnect().await;
                return fail(&message);
            }
        };
        echo_native_log::info(format!(
            "AirPlay 1 native FEEDER 就绪: name={device_name}, id={device_id}, pcmPort={port}"
        ));
        self.raop = Some(connection);
        Link {
            ok: true,
            error: None,
            format: Some(format!("{TRANSPORT_FORMAT}; AirPlay 1/RAOP")),
            pcm_port: Some(u32::from(port)),
        }
    }

    fn attach_feeder(&mut self, sender: LiveFrameSender) -> Result<u16, String> {
        let listener = match TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(err) => {
                self.last_error = Some(err.to_string());
                return Err("无法打开本机音频出口".to_string());
            }
        };
        let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(0);
        if port == 0 {
            return Err("无法打开本机音频出口".to_string());
        }
        let epoch = Arc::new(AtomicU64::new(1));
        let stats = Arc::new(FeedStats::default());
        self.epoch = 1;
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let shared_sender = Arc::new(sender);
        let feeder_sender = Arc::clone(&shared_sender);
        let feeder_epoch = Arc::clone(&epoch);
        let feeder_stop = Arc::clone(&stop);
        let feeder_paused = Arc::clone(&paused);
        let feeder_stats = Arc::clone(&stats);
        let handle = match thread::Builder::new()
            .name("airplay-feeder".to_string())
            .spawn(move || {
                feed_loop(
                    listener,
                    feeder_sender,
                    feeder_epoch,
                    feeder_stop,
                    feeder_paused,
                    feeder_stats,
                );
            }) {
            Ok(handle) => handle,
            Err(err) => {
                self.last_error = Some(err.to_string());
                let last_error = self.last_error.clone();
                self.update_status(|status| {
                    status.connected = false;
                    status.error = last_error;
                    status.feed_stats = None;
                });
                return Err("无法启动音频发送".to_string());
            }
        };
        let feed_stats = Arc::clone(&stats);
        self.feed = Some(Feed {
            stop,
            paused,
            epoch,
            sender: shared_sender,
            handle,
        });
        self.connected = true;
        self.last_error = None;
        self.update_status(|status| {
            status.connected = true;
            status.delay_sec = 0.2;
            status.error = None;
            status.feed_stats = Some(feed_stats);
        });
        Ok(port)
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
        let user_paused = self.is_feed_paused();
        let mut resume_feed = false;
        if let Some(raop) = &mut self.raop {
            if let Err(err) = raop.flush().await {
                echo_native_log::warn(format!("AirPlay 1 FLUSH 失败: {err}"));
            } else if !user_paused {
                match raop.record().await {
                    Ok(true) => resume_feed = true,
                    Ok(false) => {}
                    Err(err) => {
                        echo_native_log::warn(format!("AirPlay 1 RECORD 失败: {err}"));
                    }
                }
            }
            if resume_feed {
                self.set_feed_paused(false);
            }
        } else if self.connected {
            if let Err(err) = client.seek(seconds.max(0.0)).await {
                echo_native_log::warn(format!("AirPlay 2 SEEK 失败: {err}"));
            }
        }
        Ok(self.epoch)
    }

    async fn pause(&mut self, client: &mut airplay_client::AirPlayClient) -> Result<(), String> {
        self.set_feed_paused(true);
        let result = if let Some(raop) = &mut self.raop {
            raop.pause()
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        } else {
            client
                .pause()
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        };
        self.transport(result)
    }

    async fn resume(&mut self, client: &mut airplay_client::AirPlayClient) -> Result<(), String> {
        self.set_feed_paused(false);
        let result = if let Some(raop) = &mut self.raop {
            raop.resume()
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        } else {
            client
                .resume()
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        };
        self.transport(result)
    }

    async fn stop(&mut self, client: &mut airplay_client::AirPlayClient) -> Result<(), String> {
        self.set_feed_paused(true);
        let result = if let Some(raop) = &mut self.raop {
            raop.stop().await.map(|_| ()).map_err(|err| err.to_string())
        } else {
            client
                .stop()
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        };
        self.transport(result)
    }

    async fn volume(
        &mut self,
        client: &mut airplay_client::AirPlayClient,
        level: f32,
    ) -> Result<(), String> {
        let result = if let Some(raop) = &mut self.raop {
            raop.set_volume(level)
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        } else {
            client
                .set_volume(level)
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        };
        self.transport(result)
    }

    fn transport(&mut self, result: Result<(), String>) -> Result<(), String> {
        result
            .map(|_| {
                self.update_status(|status| {
                    status.error = None;
                });
            })
            .map_err(|err| {
                self.last_error = Some(err.clone());
                self.update_status(|status| {
                    status.error = Some(err.clone());
                });
                err
            })
    }

    fn set_feed_paused(&mut self, paused: bool) {
        if let Some(feed) = &self.feed {
            feed.paused.store(paused, Ordering::Release);
        }
    }

    fn is_feed_paused(&self) -> bool {
        self.feed
            .as_ref()
            .map(|feed| feed.paused.load(Ordering::Acquire))
            .unwrap_or(false)
    }

    fn lookup(&self, id: &str) -> Option<Device> {
        let wanted = normalize_id(id);
        cached_devices(&self.devices)
            .into_iter()
            .find(|device| device_id(device) == id || normalize_id(&device_id(device)) == wanted)
    }

    async fn shutdown(&mut self, client: &mut airplay_client::AirPlayClient) {
        if let Some(feed) = self.feed.take() {
            feed.stop.store(true, Ordering::Release);
            let _ = feed.handle.join();
        }
        if self.connected {
            if let Some(mut raop) = self.raop.take() {
                let _ = raop.stop().await;
                let _ = raop.disconnect().await;
            } else {
                let _ = client.stop().await;
                let _ = client.disconnect().await;
            }
        }
        self.connected = false;
        self.last_error = None;
        self.update_status(|status| {
            status.connected = false;
            status.delay_sec = 0.0;
            status.error = None;
            status.feed_stats = None;
        });
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
        || lower.contains("digest")
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
        supports_airplay2: device.supports_airplay2(),
        supports_raop: device.supports_raop(),
    }
}

fn device_id(device: &Device) -> String {
    device.id.to_mac_string()
}

fn discover_devices(
    timeout: Duration,
    progress: Option<Sender<FoundDevice>>,
    cache: &DeviceCache,
) -> Result<Vec<FoundDevice>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| err.to_string())?;
    let cache_for_progress = Arc::clone(cache);
    let progress_for_callback = progress.clone();
    #[cfg(target_os = "macos")]
    let devices = runtime.block_on(bonjour::discover_with_progress(timeout, move |device| {
        upsert_device_cache(&cache_for_progress, device.clone());
        if let Some(tx) = &progress_for_callback {
            let _ = tx.send(found_device(&device));
        }
    }));
    #[cfg(not(target_os = "macos"))]
    let devices = runtime.block_on(browse_devices(
        timeout,
        progress_for_callback,
        cache_for_progress,
    ))?;
    replace_device_cache(cache, devices.clone());
    Ok(devices.iter().map(found_device).collect())
}

#[cfg(not(target_os = "macos"))]
async fn browse_devices(
    timeout: Duration,
    progress: Option<Sender<FoundDevice>>,
    cache: DeviceCache,
) -> Result<Vec<Device>, String> {
    use airplay_client::Discovery;
    use airplay_discovery::{BrowseEvent, ServiceBrowser};
    use std::collections::HashMap;
    use tokio_stream::StreamExt;

    let browser = ServiceBrowser::new().map_err(|err| err.to_string())?;

    // 没有 progress 订阅者时走 `scan()`：它按 wall clock 判断超时
    // (`start.elapsed() < timeout`)，不依赖 `browse()` 那个流是否协作。
    // 只有需要边搜边回调的 `discover_each` 才必须消费流。
    if progress.is_none() {
        let devices = browser.scan(timeout).await.map_err(|err| err.to_string())?;
        for device in &devices {
            upsert_device_cache(&cache, device.clone());
        }
        return Ok(devices);
    }

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
                        upsert_device_cache(&cache, device.clone());
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

fn clamp_volume(volume: f64) -> f32 {
    if volume.is_finite() {
        (volume / 100.0).clamp(0.0, 1.0) as f32
    } else {
        0.5
    }
}

const FEED_BACKOFF_CAP: Duration = Duration::from_millis(8);

fn seed_feed_backoff(current: Duration) -> Duration {
    if current < Duration::from_millis(1) {
        Duration::from_millis(1)
    } else {
        current
    }
}

fn next_feed_backoff(current: Duration) -> Duration {
    match current.checked_mul(2) {
        Some(next) if next < FEED_BACKOFF_CAP => next,
        _ => FEED_BACKOFF_CAP,
    }
}

fn feed_loop(
    listener: TcpListener,
    sender: Arc<LiveFrameSender>,
    epoch: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    stats: Arc<FeedStats>,
) {
    listener.set_nonblocking(true).ok();
    let mut stream: Option<TcpStream> = None;
    let mut buffer = Vec::new();
    let mut pending: Option<PcmFrame> = None;
    let mut backoff = Duration::ZERO;
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
        if paused.load(Ordering::Acquire) {
            pending = None;
            backoff = Duration::ZERO;
            thread::sleep(Duration::from_millis(10));
            continue;
        }
        if !backoff.is_zero() {
            thread::sleep(backoff);
            backoff = next_feed_backoff(backoff);
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
                backoff = Duration::ZERO;
            }
            Err(err) => {
                stats.send_errors.fetch_add(1, Ordering::Relaxed);
                let disconnected = format!("{err:?}").contains("Disconnected");
                if disconnected || stop.load(Ordering::Acquire) {
                    break;
                }
                backoff = next_feed_backoff(seed_feed_backoff(backoff));
                if frame.epoch != epoch.load(Ordering::Acquire) {
                    pending = None;
                }
            }
        }
    }
}

fn feed_stats_from_arc(stats: &Arc<FeedStats>) -> (u32, u32, u32) {
    (
        stats
            .received_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        stats
            .sent_frames
            .load(Ordering::Acquire)
            .min(u64::from(u32::MAX)) as u32,
        stats
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
