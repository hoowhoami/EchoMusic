use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use image::ImageFormat;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::sync::{Arc, Mutex};
use mpris_server::{Metadata, PlaybackStatus, Player, Time, TrackId, Uri};
use tempfile::NamedTempFile;
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
    /// 更新播放位置（微秒）
    /// 如果与上次 position 差距超过阈值，自动发送 Seeked 信号
    UpdatePosition { position_us: i64, total_us: i64 },
    Shutdown,
}

pub struct LinuxMediaControls {
    command_tx: Option<UnboundedSender<MprisCommand>>,
    callback: Arc<Mutex<Option<EventCallback>>>,
}

unsafe impl Send for LinuxMediaControls {}
unsafe impl Sync for LinuxMediaControls {}

impl LinuxMediaControls {
    pub fn new() -> Self {
        Self {
            command_tx: None,
            callback: Arc::new(Mutex::new(None)),
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
    player.connect_play_pause(move |player| {
        let status = player.playback_status();
        let event = match status {
            PlaybackStatus::Playing => MediaControlEvent::pause(),
            _ => MediaControlEvent::play(),
        };
        emit_event(&cb, event);
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

/// 处理元数据更新
async fn process_metadata_update(
    player: &Player,
    title: String,
    artist: String,
    album: String,
    duration_ms: Option<f64>,
    cover_data: Option<Vec<u8>>,
    cover_url: Option<String>,
    track_counter: &mut u64,
    cover_guard: &mut Option<NamedTempFile>,
) {
    *track_counter += 1;
    let track_path = format!("/org/mpris/MediaPlayer2/Track/{}", *track_counter);
    let track_id = TrackId::try_from(track_path.as_str())
        .unwrap_or_else(|_| TrackId::NO_TRACK);

    let mut meta = Metadata::builder()
        .trackid(track_id)
        .title(title)
        .artist([artist])
        .album(album);

    if let Some(ms) = duration_ms {
        meta = meta.length(Time::from_micros((ms * 1000.0) as i64));
    }

    // 封面处理
    let mut cover_set = false;
    if let Some(ref data) = cover_data {
        if !data.is_empty() {
            // 用 image crate 解码（自动识别 PNG/WebP/JPEG/GIF 等格式）
            match image::load_from_memory(data) {
                Ok(img) => {
                    // 创建带唯一名的临时文件，避免覆盖竞态
                    match tempfile::Builder::new()
                        .prefix(".echomusic-cover-")
                        .suffix(".jpg")
                        .tempfile()
                    {
                        Ok(file) => {
                            let cover_path = file.path().to_path_buf();
                            // 统一转码为 JPEG，扩展名与实际内容一致
                            match img.save_with_format(&cover_path, ImageFormat::Jpeg) {
                                Ok(()) => {
                                    let uri = format!("file://{}", cover_path.display());
                                    meta = meta.art_url(Uri::from(uri.as_str()));
                                    // 持有新文件所有权，旧文件自动 Drop 删除
                                    *cover_guard = Some(file);
                                    cover_set = true;
                                }
                                Err(e) => {
                                    tracing::warn!("Failed to save cover as JPEG: {e}");
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!("Failed to create cover temp file: {e}");
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "Cover decode failed, will fall back to cover_url if present: {e}"
                    );
                }
            }
        }
    }

    // 转码/写入失败，或 cover_data 为空/None 时回退到 HTTP URL
    if !cover_set {
        *cover_guard = None;
        if let Some(ref url) = cover_url {
            meta = meta.art_url(Uri::from(url.as_str()));
        }
    }

    player.set_metadata(meta.build()).await.ok();
    // 切歌时重置 position 为 0
    player.set_position(Time::ZERO);
}

/// MPRIS 事件循环：在独立线程的 tokio runtime 中运行
#[allow(clippy::future_not_send)]
async fn run_mpris_loop(
    mut rx: UnboundedReceiver<MprisCommand>,
    callback: Arc<Mutex<Option<EventCallback>>>,
) {
    let player = match Player::builder("EchoMusic")
        .can_play(true)
        .can_pause(true)
        .can_go_next(true)
        .can_go_previous(true)
        .can_seek(true)
        .identity("EchoMusic")
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

    // 用于生成稳定的 track id
    let mut track_counter: u64 = 0;
    // 上次已知的 position，用于检测 seek 跳变
    let mut last_position_us: i64 = 0;
    // 当前封面临时文件的持有句柄，Drop 时自动删除文件
    let mut cover_guard: Option<NamedTempFile> = None;

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
                        process_metadata_update(
                            &player,
                            title,
                            artist,
                            album,
                            duration_ms,
                            cover_data,
                            cover_url,
                            &mut track_counter,
                            &mut cover_guard,
                        ).await;
                        last_position_us = 0;
                    }
                    MprisCommand::UpdatePlayState(status) => {
                        player.set_playback_status(status).await.ok();
                    }
                    MprisCommand::UpdatePosition { position_us, total_us: _ } => {
                        // 检测 seek 跳变：position 变化超过 3 秒视为用户主动 seek
                        let delta = (position_us - last_position_us).abs();
                        let is_seek = delta > 3_000_000; // 3 秒 = 3,000,000 微秒

                        player.set_position(Time::from_micros(position_us));

                        if is_seek && last_position_us > 0 {
                            // 发送 Seeked 信号通知外部工具（如 Waylyrics）
                            player.seeked(Time::from_micros(position_us)).await.ok();
                        }

                        last_position_us = position_us;
                    }
                    MprisCommand::Shutdown => break,
                }
            }
        }
    }
}

impl SystemMediaControls for LinuxMediaControls {
    fn initialize(&mut self, _app_name: &str) -> Result<(), String> {
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
                rt.block_on(run_mpris_loop(cmd_rx, callback));
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
            let total_us = (payload.total_time_ms * 1000.0) as i64;
            let _ = tx.send(MprisCommand::UpdatePosition { position_us, total_us });
        }
    }

    fn set_event_callback(&mut self, callback: EventCallback) {
        if let Ok(mut guard) = self.callback.lock() {
            *guard = Some(callback);
        }
    }
}