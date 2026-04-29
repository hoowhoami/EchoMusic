use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::sync::{Arc, Mutex};
use mpris_server::{
    zbus, LoopStatus, Metadata, PlaybackRate, PlaybackStatus, Player, PlayerInterface, Property,
    RootInterface, Signal, Time, TrackId, Uri, Volume,
};

/// MPRIS 播放器状态
struct MprisState {
    metadata: Metadata,
    playback_status: PlaybackStatus,
    position_us: i64,
    callback: Arc<Mutex<Option<EventCallback>>>,
}

impl MprisState {
    fn emit_event(&self, event: MediaControlEvent) {
        if let Ok(guard) = self.callback.lock() {
            if let Some(ref tsfn) = *guard {
                tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

impl RootInterface for MprisState {
    async fn identity(&self) -> zbus::fdo::Result<String> {
        Ok("EchoMusic".to_string())
    }
    async fn can_raise(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
    async fn can_quit(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
    async fn raise(&self) -> zbus::fdo::Result<()> {
        Ok(())
    }
    async fn quit(&self) -> zbus::fdo::Result<()> {
        Ok(())
    }
    async fn has_track_list(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
    async fn supported_uri_schemes(&self) -> zbus::fdo::Result<Vec<String>> {
        Ok(vec![])
    }
    async fn supported_mime_types(&self) -> zbus::fdo::Result<Vec<String>> {
        Ok(vec![])
    }
    async fn desktop_entry(&self) -> zbus::fdo::Result<String> {
        Ok("echomusic".to_string())
    }
    async fn fullscreen(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
    async fn set_fullscreen(&self, _fullscreen: bool) -> zbus::Result<()> {
        Ok(())
    }
    async fn can_set_fullscreen(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
}

impl PlayerInterface for MprisState {
    async fn play(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::play());
        Ok(())
    }
    async fn pause(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::pause());
        Ok(())
    }
    async fn play_pause(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::play());
        Ok(())
    }
    async fn stop(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::stop());
        Ok(())
    }
    async fn next(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::next());
        Ok(())
    }
    async fn previous(&self) -> zbus::fdo::Result<()> {
        self.emit_event(MediaControlEvent::previous());
        Ok(())
    }
    async fn seek(&self, offset: Time) -> zbus::fdo::Result<()> {
        let new_pos_us = self.position_us + offset.as_micros();
        let new_pos_ms = (new_pos_us as f64) / 1000.0;
        self.emit_event(MediaControlEvent::seek(new_pos_ms.max(0.0)));
        Ok(())
    }
    async fn set_position(&self, _track_id: TrackId, position: Time) -> zbus::fdo::Result<()> {
        let pos_ms = (position.as_micros() as f64) / 1000.0;
        self.emit_event(MediaControlEvent::seek(pos_ms.max(0.0)));
        Ok(())
    }
    async fn open_uri(&self, _uri: String) -> zbus::fdo::Result<()> {
        Ok(())
    }
    async fn playback_status(&self) -> zbus::fdo::Result<PlaybackStatus> {
        Ok(self.playback_status)
    }
    async fn loop_status(&self) -> zbus::fdo::Result<LoopStatus> {
        Ok(LoopStatus::None)
    }
    async fn set_loop_status(&self, _status: LoopStatus) -> zbus::Result<()> {
        Ok(())
    }
    async fn shuffle(&self) -> zbus::fdo::Result<bool> {
        Ok(false)
    }
    async fn set_shuffle(&self, _shuffle: bool) -> zbus::Result<()> {
        Ok(())
    }
    async fn rate(&self) -> zbus::fdo::Result<PlaybackRate> {
        Ok(PlaybackRate::default())
    }
    async fn set_rate(&self, _rate: PlaybackRate) -> zbus::Result<()> {
        Ok(())
    }
    async fn metadata(&self) -> zbus::fdo::Result<Metadata> {
        Ok(self.metadata.clone())
    }
    async fn volume(&self) -> zbus::fdo::Result<Volume> {
        Ok(Volume::default())
    }
    async fn set_volume(&self, _volume: Volume) -> zbus::Result<()> {
        Ok(())
    }
    async fn position(&self) -> zbus::fdo::Result<Time> {
        Ok(Time::from_micros(self.position_us))
    }
    async fn minimum_rate(&self) -> zbus::fdo::Result<PlaybackRate> {
        Ok(PlaybackRate::from(1.0))
    }
    async fn maximum_rate(&self) -> zbus::fdo::Result<PlaybackRate> {
        Ok(PlaybackRate::from(1.0))
    }
    async fn can_go_next(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
    async fn can_go_previous(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
    async fn can_play(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
    async fn can_pause(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
    async fn can_seek(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
    async fn can_control(&self) -> zbus::fdo::Result<bool> {
        Ok(true)
    }
}

pub struct LinuxMediaControls {
    player: Option<Player<MprisState>>,
    callback: Arc<Mutex<Option<EventCallback>>>,
    cover_temp_dir: Option<tempfile::TempDir>,
    runtime_handle: Option<tokio::runtime::Handle>,
}

unsafe impl Send for LinuxMediaControls {}
unsafe impl Sync for LinuxMediaControls {}

impl LinuxMediaControls {
    pub fn new() -> Self {
        Self {
            player: None,
            callback: Arc::new(Mutex::new(None)),
            cover_temp_dir: None,
            runtime_handle: None,
        }
    }
}

impl SystemMediaControls for LinuxMediaControls {
    fn initialize(&mut self, _app_name: &str) -> Result<(), String> {
        let cb = self.callback.clone();
        let temp_dir = tempfile::TempDir::new().map_err(|e| format!("Failed to create temp dir: {e}"))?;
        self.cover_temp_dir = Some(temp_dir);

        let rt = tokio::runtime::Handle::current();
        self.runtime_handle = Some(rt.clone());

        let player = rt
            .block_on(async {
                let state = MprisState {
                    metadata: Metadata::new(),
                    playback_status: PlaybackStatus::Stopped,
                    position_us: 0,
                    callback: cb,
                };
                Player::builder("EchoMusic")
                    .can_play(true)
                    .can_pause(true)
                    .can_go_next(true)
                    .can_go_previous(true)
                    .can_seek(true)
                    .build_with_state(state)
                    .await
            })
            .map_err(|e| format!("Failed to create MPRIS Player: {e}"))?;

        self.player = Some(player);
        tracing::info!("Linux MPRIS D-Bus service initialized");
        Ok(())
    }

    fn shutdown(&mut self) {
        self.player = None;
        self.cover_temp_dir = None;
        tracing::info!("Linux MPRIS D-Bus service shut down");
    }

    fn update_metadata(&self, payload: &MetadataPayload) {
        let Some(ref player) = self.player else { return };

        let mut metadata = Metadata::builder()
            .title(payload.title.clone())
            .artist([payload.artist.clone()])
            .album(payload.album.clone());

        if let Some(duration_ms) = payload.duration_ms {
            metadata = metadata.length(Time::from_micros((duration_ms * 1000.0) as i64));
        }

        // 封面：写入临时文件
        if let Some(ref data) = payload.cover_data {
            if !data.is_empty() {
                if let Some(ref temp_dir) = self.cover_temp_dir {
                    let cover_path = temp_dir.path().join("cover.jpg");
                    if std::fs::write(&cover_path, data).is_ok() {
                        let uri = format!("file://{}", cover_path.display());
                        if let Ok(art_url) = Uri::try_from(uri.as_str()) {
                            metadata = metadata.art_url(art_url);
                        }
                    }
                }
            }
        } else if let Some(ref url) = payload.cover_url {
            if let Ok(art_url) = Uri::try_from(url.as_str()) {
                metadata = metadata.art_url(art_url);
            }
        }

        let built = metadata.build();
        if let Some(ref rt) = self.runtime_handle {
            let player = player.clone();
            let _ = rt.block_on(async {
                player.set_metadata(built).await.ok();
                player.properties_changed([Property::Metadata]).await.ok();
            });
        }
    }

    fn update_play_state(&self, payload: &PlayStatePayload) {
        let Some(ref player) = self.player else { return };
        let status = match payload.status.as_str() {
            "Playing" => PlaybackStatus::Playing,
            "Paused" => PlaybackStatus::Paused,
            _ => PlaybackStatus::Stopped,
        };
        if let Some(ref rt) = self.runtime_handle {
            let player = player.clone();
            let _ = rt.block_on(async {
                player.set_playback_status(status).await.ok();
                player
                    .properties_changed([Property::PlaybackStatus])
                    .await
                    .ok();
            });
        }
    }

    fn update_timeline(&self, payload: &TimelinePayload) {
        let Some(ref player) = self.player else { return };
        let position_us = (payload.current_time_ms * 1000.0) as i64;
        if let Some(ref rt) = self.runtime_handle {
            let player = player.clone();
            let _ = rt.block_on(async {
                player.seeked(Time::from_micros(position_us)).await.ok();
            });
        }
    }

    fn set_event_callback(&mut self, callback: EventCallback) {
        if let Ok(mut guard) = self.callback.lock() {
            *guard = Some(callback);
        }
    }
}
