mod model;
mod sys_media;
#[cfg(target_os = "windows")]
mod taskbar;

use model::{MediaControlEvent, MetadataPayload, PlayStatePayload, TimelinePayload};
use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::ThreadsafeFunction;
use napi::{Env, Task};
use napi_derive::napi;
use std::sync::RwLock;
use sys_media::{create_platform_controls, SystemMediaControls};

// 用 RwLock 而非 Mutex：update_* 都是 &self（读锁，可并发），仅 initialize/shutdown/
// register_event_handler 是 &mut self（写锁，仅启动/关闭时）。这样异步化的 update_metadata
// 在工作线程持读锁解码封面时，主线程高频的 update_timeline 仍可并发拿读锁，互不阻塞。
static CONTROLS: RwLock<Option<Box<dyn SystemMediaControls>>> = RwLock::new(None);

/// 初始化媒体控制服务
#[napi]
pub fn initialize(app_name: String) -> napi::Result<()> {
    let mut controls = create_platform_controls();
    controls
        .initialize(&app_name)
        .map_err(|e| napi::Error::from_reason(format!("Init failed: {e}")))?;

    let mut guard = CONTROLS
        .write()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    *guard = Some(controls);
    Ok(())
}

/// 关闭媒体控制服务
#[napi]
pub fn shutdown() {
    if let Ok(mut guard) = CONTROLS.write() {
        if let Some(ref mut controls) = *guard {
            controls.shutdown();
        }
        *guard = None;
    }
}

/// 更新歌曲元数据任务：封面解码 / 重编码可能耗时几十 ms，放到工作线程执行，
/// 避免阻塞 Node 主线程（锁定桌面歌词时主线程阻塞会卡系统光标）。
pub struct UpdateMetadataTask {
    payload: MetadataPayload,
}

impl Task for UpdateMetadataTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let guard = CONTROLS
            .read()
            .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
        if let Some(ref controls) = *guard {
            controls.update_metadata(&self.payload);
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 更新歌曲元数据，返回 Promise<void>。封面处理在工作线程完成，不阻塞主线程。
#[napi]
pub fn update_metadata(payload: MetadataPayload) -> AsyncTask<UpdateMetadataTask> {
    AsyncTask::new(UpdateMetadataTask { payload })
}

/// 更新播放状态
#[napi]
pub fn update_play_state(payload: PlayStatePayload) -> napi::Result<()> {
    let guard = CONTROLS
        .read()
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
        .read()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref controls) = *guard {
        controls.update_timeline(&payload);
    }
    Ok(())
}

/// 注册系统媒体事件回调
#[napi]
pub fn register_event_handler(callback: ThreadsafeFunction<MediaControlEvent>) -> napi::Result<()> {
    let mut guard = CONTROLS
        .write()
        .map_err(|e| napi::Error::from_reason(format!("Lock failed: {e}")))?;
    if let Some(ref mut controls) = *guard {
        controls.set_event_callback(callback);
    }
    Ok(())
}
