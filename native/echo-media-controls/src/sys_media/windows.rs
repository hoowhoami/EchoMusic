use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::sync::{Arc, Mutex};
use windows::Media::Playback::{MediaPlayer, MediaPlayerAudioCategory};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, SystemMediaTransportControls,
    SystemMediaTransportControlsButtonPressedEventArgs,
};
use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference};

pub struct WindowsMediaControls {
    player: Option<MediaPlayer>,
    smtc: Option<SystemMediaTransportControls>,
    callback: Arc<Mutex<Option<EventCallback>>>,
}

unsafe impl Send for WindowsMediaControls {}
unsafe impl Sync for WindowsMediaControls {}

impl WindowsMediaControls {
    pub fn new() -> Self {
        Self {
            player: None,
            smtc: None,
            callback: Arc::new(Mutex::new(None)),
        }
    }

    /// 将图片 Buffer 写入 SMTC 缩略图
    fn set_thumbnail(
        updater: &windows::Media::SystemMediaTransportControlsDisplayUpdater,
        data: &[u8],
    ) -> Result<(), String> {
        let stream =
            InMemoryRandomAccessStream::new().map_err(|e| format!("Failed to create stream: {e}"))?;
        let writer =
            DataWriter::CreateDataWriter(&stream).map_err(|e| format!("Failed to create writer: {e}"))?;
        writer
            .WriteBytes(data)
            .map_err(|e| format!("Failed to write data: {e}"))?;
        writer
            .StoreAsync()
            .map_err(|e| format!("Store failed: {e}"))?
            .get()
            .map_err(|e| format!("Store get failed: {e}"))?;
        writer
            .FlushAsync()
            .map_err(|e| format!("Flush failed: {e}"))?
            .get()
            .map_err(|e| format!("Flush get failed: {e}"))?;
        writer
            .DetachStream()
            .map_err(|e| format!("Detach failed: {e}"))?;
        let reference = RandomAccessStreamReference::CreateFromStream(&stream)
            .map_err(|e| format!("Failed to create stream reference: {e}"))?;
        updater
            .SetThumbnail(&reference)
            .map_err(|e| format!("Failed to set thumbnail: {e}"))?;
        Ok(())
    }
}

impl SystemMediaControls for WindowsMediaControls {
    fn initialize(&mut self, _app_name: &str) -> Result<(), String> {
        let player = MediaPlayer::new().map_err(|e| format!("Failed to create MediaPlayer: {e}"))?;
        player
            .SetAudioCategory(MediaPlayerAudioCategory::Media)
            .map_err(|e| format!("Failed to set audio category: {e}"))?;
        player
            .CommandManager()
            .map_err(|e| format!("Failed to get CommandManager: {e}"))?
            .SetIsEnabled(false)
            .map_err(|e| format!("Failed to disable CommandManager: {e}"))?;
        let smtc = player
            .SystemMediaTransportControls()
            .map_err(|e| format!("Failed to get SMTC: {e}"))?;
        smtc.SetIsEnabled(true).ok();
        smtc.SetIsPlayEnabled(true).ok();
        smtc.SetIsPauseEnabled(true).ok();
        smtc.SetIsNextEnabled(true).ok();
        smtc.SetIsPreviousEnabled(true).ok();
        smtc.SetIsStopEnabled(true).ok();
        smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed).ok();

        // 注册按钮事件
        let cb = self.callback.clone();
        smtc.ButtonPressed(
            &windows::Foundation::TypedEventHandler::<
                SystemMediaTransportControls,
                SystemMediaTransportControlsButtonPressedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args {
                    let event = match args.Button()? {
                        windows::Media::SystemMediaTransportControlsButton::Play => {
                            MediaControlEvent::play()
                        }
                        windows::Media::SystemMediaTransportControlsButton::Pause => {
                            MediaControlEvent::pause()
                        }
                        windows::Media::SystemMediaTransportControlsButton::Stop => {
                            MediaControlEvent::stop()
                        }
                        windows::Media::SystemMediaTransportControlsButton::Next => {
                            MediaControlEvent::next()
                        }
                        windows::Media::SystemMediaTransportControlsButton::Previous => {
                            MediaControlEvent::previous()
                        }
                        _ => return Ok(()),
                    };
                    if let Ok(guard) = cb.lock() {
                        if let Some(ref tsfn) = *guard {
                            tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }
                Ok(())
            }),
        )
        .map_err(|e| format!("Failed to register button event: {e}"))?;

        self.player = Some(player);
        self.smtc = Some(smtc);
        tracing::info!("Windows SMTC initialized");
        Ok(())
    }

    fn shutdown(&mut self) {
        if let Some(ref smtc) = self.smtc {
            let _ = smtc.SetIsEnabled(false);
            let _ = smtc.SetPlaybackStatus(MediaPlaybackStatus::Closed);
        }
        if let Some(ref player) = self.player {
            player.Close().ok();
        }
        self.smtc = None;
        self.player = None;
        tracing::info!("Windows SMTC shut down");
    }

    fn update_metadata(&self, payload: &MetadataPayload) {
        let Some(ref smtc) = self.smtc else { return };
        let updater = match smtc.DisplayUpdater() {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!("Failed to get DisplayUpdater: {e}");
                return;
            }
        };

        if let Err(e) = updater.SetType(MediaPlaybackType::Music) {
            tracing::warn!("Failed to set MediaPlaybackType: {e}");
            return;
        }

        if let Ok(props) = updater.MusicProperties() {
            let _ = props.SetTitle(&windows::core::HSTRING::from(&payload.title));
            let _ = props.SetArtist(&windows::core::HSTRING::from(&payload.artist));
            let _ = props.SetAlbumTitle(&windows::core::HSTRING::from(&payload.album));
        }

        // 设置封面
        if let Some(ref data) = payload.cover_data {
            if !data.is_empty() {
                if let Err(e) = Self::set_thumbnail(&updater, data) {
                    tracing::warn!("Failed to set SMTC thumbnail: {e}");
                }
            }
        }

        if let Err(e) = updater.Update() {
            tracing::warn!("SMTC DisplayUpdater.Update failed: {e}");
        }
    }

    fn update_play_state(&self, payload: &PlayStatePayload) {
        let Some(ref smtc) = self.smtc else { return };
        let status = match payload.status.as_str() {
            "Playing" => MediaPlaybackStatus::Playing,
            "Paused" => MediaPlaybackStatus::Paused,
            "Stopped" => MediaPlaybackStatus::Stopped,
            _ => MediaPlaybackStatus::Closed,
        };
        let _ = smtc.SetPlaybackStatus(status);
    }

    fn update_timeline(&self, payload: &TimelinePayload) {
        let Some(ref smtc) = self.smtc else { return };
        let props = match windows::Media::SystemMediaTransportControlsTimelineProperties::new() {
            Ok(p) => p,
            Err(_) => return,
        };
        let current = windows::Foundation::TimeSpan::from(std::time::Duration::from_millis(
            payload.current_time_ms as u64,
        ));
        let total = windows::Foundation::TimeSpan::from(std::time::Duration::from_millis(
            payload.total_time_ms as u64,
        ));
        let zero = windows::Foundation::TimeSpan::from(std::time::Duration::ZERO);
        let _ = props.SetPosition(current);
        let _ = props.SetStartTime(zero);
        let _ = props.SetEndTime(total);
        let _ = props.SetMinSeekTime(zero);
        let _ = props.SetMaxSeekTime(total);
        let _ = smtc.UpdateTimelineProperties(&props);
    }

    fn set_event_callback(&mut self, callback: EventCallback) {
        if let Ok(mut guard) = self.callback.lock() {
            *guard = Some(callback);
        }
    }
}
