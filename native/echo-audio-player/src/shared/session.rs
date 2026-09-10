use super::SharedAudio;
use crate::decoder::{DecodeCommand, DecoderData};
use crate::output::AudioOutputHandle;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

pub struct PlaybackSession {
    pub shared: Arc<SharedAudio>,
    pub output_thread: Option<AudioOutputHandle>,
    pub filter_thread: Option<JoinHandle<()>>,
    pub decode_thread: Option<JoinHandle<Option<DecoderData>>>,
    pub decode_commands: Option<SyncSender<DecodeCommand>>,
    pub position_thread: Option<JoinHandle<()>>,
}

impl PlaybackSession {
    pub fn stop_decode_background(&mut self, reason: &'static str) {
        if let Some(sender) = self.decode_commands.take() {
            let _ = sender.try_send(DecodeCommand::Stop);
        }
        if let Some(handle) = self.decode_thread.take() {
            join_decode_background(handle, reason);
        }
    }

    pub fn stop_background(self) {
        let pending = Arc::new(Mutex::new(Some(self)));
        let worker_pending = pending.clone();
        let spawned = std::thread::Builder::new()
            .name("player-session-stop".to_string())
            .spawn(move || {
                if let Some(session) = take_pending(&worker_pending) {
                    session.stop_blocking();
                }
            });
        if spawned.is_err() {
            if let Some(session) = take_pending(&pending) {
                session.stop_blocking();
            }
        }
    }

    pub fn stop_blocking(mut self) {
        self.shared.request_stop();
        let decode_thread = self.decode_thread.take();
        let filter_thread = self.filter_thread.take();
        let output_thread = self.output_thread.take();
        let position_thread = self.position_thread.take();
        if let Some(handle) = decode_thread {
            let _ = handle.join();
        }
        if let Some(handle) = filter_thread {
            let _ = handle.join();
        }
        if let Some(handle) = output_thread {
            handle.shutdown();
        }
        if let Some(handle) = position_thread {
            let _ = handle.join();
        }
    }
}

pub fn join_decode_background(handle: JoinHandle<Option<DecoderData>>, reason: &'static str) {
    let name = format!("player-decode-reaper-{reason}");
    let pending = Arc::new(Mutex::new(Some(handle)));
    let worker_pending = pending.clone();
    let spawned = std::thread::Builder::new().name(name).spawn(move || {
        if let Some(handle) = take_pending(&worker_pending) {
            let _ = handle.join();
        }
    });
    if spawned.is_err() {
        if let Some(handle) = take_pending(&pending) {
            let _ = handle.join();
        }
    }
}

fn take_pending<T>(pending: &Mutex<Option<T>>) -> Option<T> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
}
