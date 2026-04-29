use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::sync::{Arc, Mutex};
use mpris_server::{Metadata, PlaybackStatus, Player, Time, Uri};

/// 通过回调发送媒体控制事件
fn emit_event(callback: &Arc<Mutex<Option<EventCallback>>>, event: MediaControlEvent) {
    if let Ok(guard) = callback.lock() {
        if let Some(ref tsfn) = *guard {
            tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

pub struct LinuxMediaControls {
    player: Option<Player>,
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
        let temp_dir = tempfile::TempDir::new()
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;
        self.cover_temp_dir = Some(temp_dir);

        let rt = tokio::runtime::Handle::current();
        self.runtime_handle = Some(rt.clone());

        let player = rt
            .block_on(async {
                Player::builder("EchoMusic")
                    .can_play(true)
                    .can_pause(true)
                    .can_go_next(true)
                    .can_go_previous(true)
                    .can_seek(true)
                    .build()
                    .await
            })
            .map_err(|e| format!("Failed to create MPRIS Player: {e}"))?;

        // 注册媒体控制事件回调
        let cb = self.callback.clone();
        player.connect_play(move |_| {
            emit_event(&cb, MediaControlEvent::play());
        });

        let cb = self.callback.clone();
        player.connect_pause(move |_| {
            emit_event(&cb, MediaControlEvent::pause());
        });

        let cb = self.callback.clone();
        player.connect_play_pause(move |_| {
            emit_event(&cb, MediaControlEvent::play());
        });

        let cb = self.callback.clone();
        player.connect_stop(move |_| {
            emit_event(&cb, MediaControlEvent::stop());
        });

        let cb = self.callback.clone();
        player.connect_next(move |_| {
            emit_event(&cb, MediaControlEvent::next());
        });

        let cb = self.callback.clone();
        player.connect_previous(move |_| {
            emit_event(&cb, MediaControlEvent::previous());
        });

        let cb = self.callback.clone();
        player.connect_seek(move |p, offset| {
            let current_us = p.position().as_micros();
            let new_us = current_us + offset.as_micros();
            let new_ms = (new_us as f64) / 1000.0;
            emit_event(&cb, MediaControlEvent::seek(new_ms.max(0.0)));
        });

        let cb = self.callback.clone();
        player.connect_set_position(move |_, _track_id, position| {
            let pos_ms = (position.as_micros() as f64) / 1000.0;
            emit_event(&cb, MediaControlEvent::seek(pos_ms.max(0.0)));
        });

        // 启动事件处理任务
        // Player 不实现 Clone，run() 需要 &self，在 spawn 前调用获取 task
        let run_task = player.run();
        rt.spawn(async move {
            run_task.await;
        });

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
                        metadata = metadata.art_url(Uri::from(uri.as_str()));
                    }
                }
            }
        } else if let Some(ref url) = payload.cover_url {
            metadata = metadata.art_url(Uri::from(url.as_str()));
        }

        let built = metadata.build();
        if let Some(ref rt) = self.runtime_handle {
            let _ = rt.block_on(async {
                player.set_metadata(built).await.ok();
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
            let _ = rt.block_on(async {
                player.set_playback_status(status).await.ok();
            });
        }
    }

    fn update_timeline(&self, payload: &TimelinePayload) {
        let Some(ref player) = self.player else { return };
        let position_us = (payload.current_time_ms * 1000.0) as i64;
        if let Some(ref rt) = self.runtime_handle {
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
