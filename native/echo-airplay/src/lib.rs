//! AirPlay sender. Transport is ALAC at 44100 Hz, 16-bit stereo.
//! The input is i16. This module does not preserve 24-bit samples.

#![deny(unsafe_code)]

mod bonjour;
mod pcm;
mod session;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;

use session::{Link, Session, Status};

static SESSION: OnceLock<Session> = OnceLock::new();

fn session() -> &'static Session {
    SESSION.get_or_init(Session::start)
}

#[napi(object)]
pub struct AirplayFound {
    pub id: String,
    pub name: String,
    pub model: String,
    pub addresses: Vec<String>,
    pub needs_pin: bool,
}

#[napi(object)]
pub struct AirplayLink {
    pub ok: bool,
    pub error: Option<String>,
    pub format: Option<String>,
    pub pcm_port: Option<u32>,
}

#[napi(object)]
pub struct AirplayState {
    pub connected: bool,
    pub delay_sec: f64,
    pub format: String,
    pub input_bits: u32,
    pub error: Option<String>,
    pub feeder_received_frames: u32,
    pub feeder_sent_frames: u32,
    pub feeder_send_errors: u32,
}

fn link_of(link: Link) -> AirplayLink {
    AirplayLink {
        ok: link.ok,
        error: link.error,
        format: link.format,
        pcm_port: link.pcm_port,
    }
}

fn state_of(status: Status) -> AirplayState {
    AirplayState {
        connected: status.connected,
        delay_sec: status.delay_sec,
        format: status.format,
        input_bits: status.input_bits,
        error: status.error,
        feeder_received_frames: status.feeder_received_frames,
        feeder_sent_frames: status.feeder_sent_frames,
        feeder_send_errors: status.feeder_send_errors,
    }
}

fn found_of(device: session::FoundDevice) -> AirplayFound {
    AirplayFound {
        id: device.id,
        name: device.name,
        model: device.model,
        addresses: device.addresses,
        needs_pin: device.needs_pin,
    }
}

#[napi]
pub fn discovery_backend() -> String {
    session::discovery_backend().to_string()
}

#[napi]
pub async fn discover(timeout_ms: u32) -> Result<Vec<AirplayFound>> {
    let found = tokio::task::spawn_blocking(move || session().discover(timeout_ms))
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)?;
    Ok(found.into_iter().map(found_of).collect())
}

#[napi]
pub async fn discover_each(
    timeout_ms: u32,
    callback: ThreadsafeFunction<AirplayFound>,
) -> Result<Vec<AirplayFound>> {
    let (progress_tx, progress_rx) = mpsc::channel();
    let progress_handle = thread::spawn(move || {
        while let Ok(device) = progress_rx.recv() {
            callback.call(
                Ok(found_of(device)),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    });
    let found = tokio::task::spawn_blocking(move || {
        session().discover_with_progress(timeout_ms, Some(progress_tx))
    })
    .await
    .map_err(|err| Error::from_reason(err.to_string()))?
    .map_err(Error::from_reason)?;
    let _ = progress_handle.join();
    Ok(found.into_iter().map(found_of).collect())
}

#[napi]
pub async fn connect(id: String, pin: String) -> Result<AirplayLink> {
    let link = tokio::task::spawn_blocking(move || session().connect(id, pin))
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)?;
    Ok(link_of(link))
}

#[napi]
pub async fn disconnect() -> Result<()> {
    tokio::task::spawn_blocking(|| session().disconnect())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn pause() -> Result<()> {
    tokio::task::spawn_blocking(|| session().pause())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn resume() -> Result<()> {
    tokio::task::spawn_blocking(|| session().resume())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn seek(seconds: f64) -> Result<u32> {
    tokio::task::spawn_blocking(move || session().seek(seconds))
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn stop() -> Result<()> {
    tokio::task::spawn_blocking(|| session().stop())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn set_volume(volume: f64) -> Result<()> {
    tokio::task::spawn_blocking(move || session().volume(volume))
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub async fn flush_track() -> Result<u32> {
    tokio::task::spawn_blocking(|| session().flush())
        .await
        .map_err(|err| Error::from_reason(err.to_string()))?
        .map_err(Error::from_reason)
}

#[napi]
pub fn status() -> AirplayState {
    session().status().map(state_of).unwrap_or(AirplayState {
        connected: false,
        delay_sec: 0.0,
        format: pcm::TRANSPORT_FORMAT.to_string(),
        input_bits: u32::from(pcm::INPUT_BITS),
        error: Some("AirPlay 发送线程没有响应".to_string()),
        feeder_received_frames: 0,
        feeder_sent_frames: 0,
        feeder_send_errors: 0,
    })
}

#[napi]
pub fn clear_records() -> Result<()> {
    session().clear().map_err(Error::from_reason)
}
