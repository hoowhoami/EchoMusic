use super::SharedAudio;
use std::sync::Arc;
use std::thread::JoinHandle;

pub struct PlaybackSession {
    pub shared: Arc<SharedAudio>,
    pub output_thread: Option<JoinHandle<()>>,
    pub filter_thread: Option<JoinHandle<()>>,
    pub decode_thread: Option<JoinHandle<Option<crate::decoder::DecoderData>>>,
    pub position_thread: Option<JoinHandle<()>>,
}

impl PlaybackSession {
    pub fn stop_background(self) {
        let _ = std::thread::Builder::new()
            .name("player-session-stop".to_string())
            .spawn(move || self.stop_blocking());
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
            let _ = handle.join();
        }
        if let Some(handle) = position_thread {
            let _ = handle.join();
        }
    }
}
