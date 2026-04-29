use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::sync::{Arc, Mutex};
use mpris_server::{Metadata, PlaybackStatus, Player, Time, Uri};
use tokio::sync::mpsc::{UnboundedSender, UnboundedReceiver, unbounded_channel};

/// 通过回调发送媒体控制事件
fn emit_event(callback: &Arc<Mutex<Option<EventCallback>>>, event: MediaControlEvent) {
    if let Ok(guard) = callback.lock() {
        if let Some(ref tsfn) = *guard {
            tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
        }
    }
}

/// 主线程发给 MPRIS 线程的命令
enum MprisCommand {
    UpdateMetadata {
        title: String,
        artist: String,
        album: String,
        duration_ms: Option<f64>,
        cover_data: Option<Vec<u8>>,
        cover_url: Option<String>,
    },
    UpdatePlayState(PlaybackStatus),
    UpdateTimeline(i64),
    Shutdown,
}

pub struct LinuxMediaControls {
    command_tx: Option<UnboundedSender<MprisCommand>>,
    callback: Arc<Mutex<Option<EventCallback>>>,
    cover_temp_dir: Option<tempfile::TempDir>,
}

unsafe impl Send for LinuxMediaControls {}
unsafe impl Sync for LinuxMediaControls {}

impl LinuxMediaControls {
    pub fn new() -> Self {
        Self {
            command_tx: None,
            callback: Arc::new(Mutex::new(None)),
            cover_temp_dir: None,
        }
    }
}

/// 注册 Player 的媒体控制事件回调
fn setup_signals(player: &Player, callback: Arc<Mutex<Option<EventCallback>>>) {
    let cb = callback.clone();
    player.connect_play(move |_| {
        emit_event(&cb, MediaControlEvent::play());
    });
    let cb = callback.clone();
    player.connect_pause(move |_| {
        emit_event(&cb, MediaControlEvent::pause());
    });
    let cb = callback.clone();
    player.connect_play_pause(move |_| {
        emit_event(&cb, MediaControlEvent::play());
    });
    let cb = callback.clone();
    player.connect_stop(move |_| {
        emit_event(&cb, MediaControlEvent::stop());
    });
    let cb = callback.clone();
    player.connect_next(move |_| {
        emit_event(&cb, MediaControlEvent::next());
    });
    let cb = callback.clone();
    player.connect_previous(move |_| {
        emit_event(&cb, MediaControlEvent::previous());
    });
    let cb = callback.clone();
    player.connect_seek(move |p, offset| {
        let current_us = p.position().as_micros();
        let new_us = current_us.saturating_add(offset.as_micros());
        let new_ms = (new_us.max(0) as f64) / 1000.0;
        emit_event(&cb, MediaControlEvent::seek(new_ms));
    });
    player.connect_set_position(move |_, _track_id, position| {
        let pos_ms = (position.as_micros() as f64) / 1000.0;
        emit_event(&callback, MediaControlEvent::seek(pos_ms.max(0.0)));
    });
}

/// MPRIS 事件循环：在独立线程的 tokio runtime 中运行
#[allow(clippy::future_not_send)]
async fn run_mpris_loop(
    mut rx: UnboundedReceiver<MprisCommand>,
    callback: Arc<Mutex<Option<EventCallback>>>,
    cover_temp_path: std::path::PathBuf,
) {
    let player = match Player::builder("EchoMusic")
        .can_play(true)
        .can_pause(true)
        .can_go_next(true)
        .can_go_previous(true)
        .can_seek(true)
        .build()
        .await
    {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("Failed to create MPRIS Player: {e}");
            return;
        }
    };

    setup_signals(&player, callback);

    // pin server_task 以便在 select! 中使用
    let server_task = player.run();
    tokio::pin!(server_task);

    loop {
        tokio::select! {
            // D-Bus 事件循环
            () = &mut server_task => {
                tracing::error!("MPRIS D-Bus connection unexpectedly closed");
                break;
            }
            // 来自主线程的命令
            cmd_opt = rx.recv() => {
                let Some(cmd) = cmd_opt else { break };
                match cmd {
                    MprisCommand::UpdateMetadata {
                        title, artist, album, duration_ms, cover_data, cover_url,
                    } => {
                        let mut meta = Metadata::builder()
                            .title(title)
                            .artist([artist])
                            .album(album);
                        if let Some(ms) = duration_ms {
                            meta = meta.length(Time::from_micros((ms * 1000.0) as i64));
                        }
                        // 封面
                        if let Some(ref data) = cover_data {
                            if !data.is_empty() {
                                let cover_path = cover_temp_path.join("cover.jpg");
                                if std::fs::write(&cover_path, data).is_ok() {
                                    let uri = format!("file://{}", cover_path.display());
                                    meta = meta.art_url(Uri::from(uri.as_str()));
                                }
                            }
                        } else if let Some(ref url) = cover_url {
                            meta = meta.art_url(Uri::from(url.as_str()));
                        }
                        player.set_metadata(meta.build()).await.ok();
                    }
                    MprisCommand::UpdatePlayState(status) => {
                        player.set_playback_status(status).await.ok();
                    }
                    MprisCommand::UpdateTimeline(position_us) => {
                        player.seeked(Time::from_micros(position_us)).await.ok();
                    }
                    MprisCommand::Shutdown => break,
                }
            }
        }
    }
}

impl SystemMediaControls for LinuxMediaControls {
    fn initialize(&mut self, _app_name: &str) -> Result<(), String> {
        let temp_dir = tempfile::TempDir::new()
            .map_err(|e| format!("Failed to create temp dir: {e}"))?;
        let temp_path = temp_dir.path().to_path_buf();
        self.cover_temp_dir = Some(temp_dir);

        let (cmd_tx, cmd_rx) = unbounded_channel::<MprisCommand>();
        let callback = self.callback.clone();

        // Player 和 run_task 都不是 Send，所有操作在独立线程的 tokio runtime 中完成
        std::thread::Builder::new()
            .name("mpris-event-loop".to_string())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("failed to create MPRIS tokio runtime");
                rt.block_on(run_mpris_loop(cmd_rx, callback, temp_path));
            })
            .map_err(|e| format!("Failed to spawn MPRIS thread: {e}"))?;

        self.command_tx = Some(cmd_tx);
        tracing::info!("Linux MPRIS D-Bus service initialized");
        Ok(())
    }

    fn shutdown(&mut self) {
        if let Some(tx) = self.command_tx.take() {
            let _ = tx.send(MprisCommand::Shutdown);
        }
        self.cover_temp_dir = None;
        tracing::info!("Linux MPRIS D-Bus service shut down");
    }

    fn update_metadata(&self, payload: &MetadataPayload) {
        if let Some(ref tx) = self.command_tx {
            let _ = tx.send(MprisCommand::UpdateMetadata {
                title: payload.title.clone(),
                artist: payload.artist.clone(),
                album: payload.album.clone(),
                duration_ms: payload.duration_ms,
                cover_data: payload.cover_data.clone(),
                cover_url: payload.cover_url.clone(),
            });
        }
    }

    fn update_play_state(&self, payload: &PlayStatePayload) {
        if let Some(ref tx) = self.command_tx {
            let status = match payload.status.as_str() {
                "Playing" => PlaybackStatus::Playing,
                "Paused" => PlaybackStatus::Paused,
                _ => PlaybackStatus::Stopped,
            };
            let _ = tx.send(MprisCommand::UpdatePlayState(status));
        }
    }

    fn update_timeline(&self, payload: &TimelinePayload) {
        if let Some(ref tx) = self.command_tx {
            let position_us = (payload.current_time_ms * 1000.0) as i64;
            let _ = tx.send(MprisCommand::UpdateTimeline(position_us));
        }
    }

    fn set_event_callback(&mut self, callback: EventCallback) {
        if let Ok(mut guard) = self.callback.lock() {
            *guard = Some(callback);
        }
    }
}
