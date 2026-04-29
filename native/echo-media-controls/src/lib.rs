mod model;
mod sys_media;

use model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use napi::threadsafe_function::ThreadsafeFunction;
use napi_derive::napi;
use std::sync::Mutex;
use sys_media::{create_platform_controls, SystemMediaControls};

static CONTROLS: Mutex<Option<Box<dyn SystemMediaControls>>> = Mutex::new(None);

/// 初始化媒体控制服务
#[napi]
pub fn initialize(app_name: String) -> napi::Result<()> {
    let mut controls = create_platform_controls();
    controls
        .initialize(&app_name)
        .map_err(|e| napi::Error::from_reason(format!("Init failed: {e}")))?;

    let mut guard = CONTROLS
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    *guard = Some(controls);
    Ok(())
}

/// 关闭媒体控制服务
#[napi]
pub fn shutdown() {
    if let Ok(mut guard) = CONTROLS.lock() {
        if let Some(ref mut controls) = *guard {
            controls.shutdown();
        }
        *guard = None;
    }
}

/// 更新歌曲元数据
#[napi]
pub fn update_metadata(payload: MetadataPayload) -> napi::Result<()> {
    let guard = CONTROLS
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref controls) = *guard {
        controls.update_metadata(&payload);
    }
    Ok(())
}

/// 更新播放状态
#[napi]
pub fn update_play_state(payload: PlayStatePayload) -> napi::Result<()> {
    let guard = CONTROLS
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref controls) = *guard {
        controls.update_play_state(&payload);
    }
    Ok(())
}

/// 更新播放进度
#[napi]
pub fn update_timeline(payload: TimelinePayload) -> napi::Result<()> {
    let guard = CONTROLS
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref controls) = *guard {
        controls.update_timeline(&payload);
    }
    Ok(())
}

/// 注册系统媒体事件回调
#[napi]
pub fn register_event_handler(
    callback: ThreadsafeFunction<MediaControlEvent>,
) -> napi::Result<()> {
    let mut guard = CONTROLS
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref mut controls) = *guard {
        controls.set_event_callback(callback);
    }
    Ok(())
}
