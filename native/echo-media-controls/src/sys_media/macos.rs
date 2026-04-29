use crate::model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use super::{EventCallback, SystemMediaControls};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{AnyThread, Message};
use objc2_app_kit::NSImage;
use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSSize, NSString};
use objc2_media_player::{
    MPChangePlaybackPositionCommandEvent, MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle,
    MPMediaItemPropertyArtist, MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration,
    MPMediaItemPropertyTitle, MPNowPlayingInfoCenter, MPNowPlayingInfoPropertyElapsedPlaybackTime,
    MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommand,
    MPRemoteCommandCenter, MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
};

pub struct MacMediaControls {
    np_info_ctr: Retained<MPNowPlayingInfoCenter>,
    cmd_ctr: Retained<MPRemoteCommandCenter>,
    info: Mutex<Retained<NSMutableDictionary<NSString, AnyObject>>>,
    event_handler: Arc<Mutex<Option<EventCallback>>>,
    target_tokens: Mutex<Vec<(Retained<MPRemoteCommand>, Retained<AnyObject>)>>,
}

unsafe impl Send for MacMediaControls {}
unsafe impl Sync for MacMediaControls {}

impl MacMediaControls {
    pub fn new() -> Self {
        unsafe {
            let np_info_ctr = MPNowPlayingInfoCenter::defaultCenter();
            let cmd_ctr = MPRemoteCommandCenter::sharedCommandCenter();
            let info = NSMutableDictionary::new();
            Self {
                np_info_ctr,
                cmd_ctr,
                info: Mutex::new(info),
                event_handler: Arc::new(Mutex::new(None)),
                target_tokens: Mutex::new(Vec::new()),
            }
        }
    }

    fn store_token(&self, command: &MPRemoteCommand, token: Retained<AnyObject>) {
        if let Ok(mut tokens) = self.target_tokens.lock() {
            tokens.push((command.retain(), token));
        }
    }

    /// 注册简单命令（播放/暂停/上下首/停止）
    fn add_simple_handler(&self, command: &MPRemoteCommand, event: MediaControlEvent) {
        let handler_arc = self.event_handler.clone();
        let block = RcBlock::new(
            move |_: NonNull<MPRemoteCommandEvent>| -> MPRemoteCommandHandlerStatus {
                if let Ok(guard) = handler_arc.lock() {
                    if let Some(ref tsfn) = *guard {
                        tsfn.call(
                            Ok(event.clone()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                }
                MPRemoteCommandHandlerStatus::Success
            },
        );
        unsafe {
            command.setEnabled(true);
            let token = command.addTargetWithHandler(&block);
            self.store_token(command, token);
        }
    }

    /// 注册 togglePlayPause 命令
    fn add_toggle_handler(&self) {
        let command = unsafe { self.cmd_ctr.togglePlayPauseCommand() };
        let handler_arc = self.event_handler.clone();
        let info_ctr = self.np_info_ctr.clone();

        let block = RcBlock::new(
            move |_: NonNull<MPRemoteCommandEvent>| -> MPRemoteCommandHandlerStatus {
                let current_state = unsafe { info_ctr.playbackState() };
                let event = if current_state == MPNowPlayingPlaybackState::Playing {
                    MediaControlEvent::pause()
                } else {
                    MediaControlEvent::play()
                };
                if let Ok(guard) = handler_arc.lock() {
                    if let Some(ref tsfn) = *guard {
                        tsfn.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                MPRemoteCommandHandlerStatus::Success
            },
        );
        unsafe {
            command.setEnabled(true);
            let token = command.addTargetWithHandler(&block);
            self.store_token(&command, token);
        }
    }

    /// 注册 seek 命令
    fn add_seek_handler(&self) {
        let command = unsafe { self.cmd_ctr.changePlaybackPositionCommand() };
        let handler_arc = self.event_handler.clone();

        let block = RcBlock::new(
            move |event: NonNull<MPRemoteCommandEvent>| -> MPRemoteCommandHandlerStatus {
                let seek_evt_opt = unsafe { Retained::retain(event.as_ptr()) }
                    .and_then(|evt| evt.downcast::<MPChangePlaybackPositionCommandEvent>().ok());

                if let Some(seek_evt) = seek_evt_opt {
                    let position_s = unsafe { seek_evt.positionTime() };
                    let position_ms = position_s * 1000.0;
                    if let Ok(guard) = handler_arc.lock() {
                        if let Some(ref tsfn) = *guard {
                            tsfn.call(
                                Ok(MediaControlEvent::seek(position_ms)),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                    }
                }
                MPRemoteCommandHandlerStatus::Success
            },
        );
        unsafe {
            command.setEnabled(true);
            let token = command.addTargetWithHandler(&block);
            self.store_token(&command, token);
        }
    }

    fn setup_event_listeners(&self) {
        unsafe {
            self.add_simple_handler(&self.cmd_ctr.playCommand(), MediaControlEvent::play());
            self.add_simple_handler(&self.cmd_ctr.pauseCommand(), MediaControlEvent::pause());
            self.add_toggle_handler();
            self.add_simple_handler(
                &self.cmd_ctr.previousTrackCommand(),
                MediaControlEvent::previous(),
            );
            self.add_simple_handler(&self.cmd_ctr.nextTrackCommand(), MediaControlEvent::next());
            self.add_simple_handler(&self.cmd_ctr.stopCommand(), MediaControlEvent::stop());
        }
        self.add_seek_handler();
    }
}

impl SystemMediaControls for MacMediaControls {
    fn initialize(&mut self, _app_name: &str) -> Result<(), String> {
        tracing::info!("macOS MPNowPlayingInfoCenter initialized");
        Ok(())
    }

    fn shutdown(&mut self) {
        // 移除所有命令 handler
        if let Ok(mut tokens) = self.target_tokens.lock() {
            for (command, token) in tokens.drain(..) {
                unsafe {
                    command.removeTarget(Some(&token));
                }
            }
        }
        unsafe {
            self.np_info_ctr.setNowPlayingInfo(None);
        }
        tracing::info!("macOS MPNowPlayingInfoCenter shut down");
    }

    fn update_metadata(&self, payload: &MetadataPayload) {
        let Ok(info) = self.info.lock() else { return };

        unsafe {
            // 基础文本信息
            info.setObject_forKey(
                &NSString::from_str(&payload.title),
                ProtocolObject::from_ref(MPMediaItemPropertyTitle),
            );
            info.setObject_forKey(
                &NSString::from_str(&payload.artist),
                ProtocolObject::from_ref(MPMediaItemPropertyArtist),
            );
            info.setObject_forKey(
                &NSString::from_str(&payload.album),
                ProtocolObject::from_ref(MPMediaItemPropertyAlbumTitle),
            );

            // 重置已播放时间
            info.setObject_forKey(
                &NSNumber::new_f64(0.0),
                ProtocolObject::from_ref(MPNowPlayingInfoPropertyElapsedPlaybackTime),
            );

            // 时长
            if let Some(duration_ms) = payload.duration_ms {
                let duration_s = duration_ms / 1000.0;
                info.setObject_forKey(
                    &NSNumber::new_f64(duration_s),
                    ProtocolObject::from_ref(MPMediaItemPropertyPlaybackDuration),
                );
            }

            // 封面
            if let Some(ref data) = payload.cover_data {
                if !data.is_empty() {
                    let ns_data = NSData::from_vec(data.clone());
                    let img = NSImage::alloc();
                    if let Some(img) = NSImage::initWithData(img, &ns_data) {
                        let img_size = img.size();
                        let handler = RcBlock::new(move |_: NSSize| -> NonNull<NSImage> {
                            let ptr = Retained::as_ptr(&img);
                            NonNull::new(ptr.cast_mut()).expect("NSImage pointer should not be null")
                        });
                        let artwork = MPMediaItemArtwork::alloc();
                        let artwork = MPMediaItemArtwork::initWithBoundsSize_requestHandler(
                            artwork, img_size, &handler,
                        );
                        info.setObject_forKey(
                            &artwork,
                            ProtocolObject::from_ref(MPMediaItemPropertyArtwork),
                        );
                    }
                }
            }

            self.np_info_ctr.setNowPlayingInfo(Some(&*info));
        }
    }

    fn update_play_state(&self, payload: &PlayStatePayload) {
        let state = match payload.status.as_str() {
            "Playing" => MPNowPlayingPlaybackState::Playing,
            "Paused" => MPNowPlayingPlaybackState::Paused,
            "Stopped" => MPNowPlayingPlaybackState::Stopped,
            _ => MPNowPlayingPlaybackState::Unknown,
        };
        unsafe {
            self.np_info_ctr.setPlaybackState(state);
        }
    }

    fn update_timeline(&self, payload: &TimelinePayload) {
        let Ok(info) = self.info.lock() else { return };
        let current_s = payload.current_time_ms / 1000.0;
        let total_s = payload.total_time_ms / 1000.0;

        unsafe {
            info.setObject_forKey(
                &NSNumber::new_f64(current_s),
                ProtocolObject::from_ref(MPNowPlayingInfoPropertyElapsedPlaybackTime),
            );
            info.setObject_forKey(
                &NSNumber::new_f64(1.0),
                ProtocolObject::from_ref(MPNowPlayingInfoPropertyPlaybackRate),
            );
            info.setObject_forKey(
                &NSNumber::new_f64(total_s),
                ProtocolObject::from_ref(MPMediaItemPropertyPlaybackDuration),
            );
            self.np_info_ctr.setNowPlayingInfo(Some(&*info));
        }
    }

    fn set_event_callback(&mut self, callback: EventCallback) {
        if let Ok(mut guard) = self.event_handler.lock() {
            *guard = Some(callback);
        }
        self.setup_event_listeners();
    }
}
