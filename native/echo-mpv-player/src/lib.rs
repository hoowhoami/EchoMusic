// echo-mpv-player NAPI 入口

mod event_loop;
mod mpv_ffi;
mod player;
mod types;

use event_loop::start_event_loop;
use mpv_ffi::MpvLib;
use napi::bindgen_prelude::AsyncTask;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Task};
use napi_derive::napi;
use player::{MpvPlayer, MpvPlayerConfig};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;
use types::*;

/// 全局播放器实例
static PLAYER: Mutex<Option<Arc<MpvPlayer>>> = Mutex::new(None);
static PLAYER_LIFECYCLE: RwLock<()> = RwLock::new(());
/// 事件线程句柄
static EVENT_THREAD: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
/// 事件回调（Arc<Mutex> 包装，供多线程共享访问）
static EVENT_CALLBACK: Mutex<Option<Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>>> =
    Mutex::new(None);
static NEXT_LOAD_SEQ: AtomicU64 = AtomicU64::new(0);
static PENDING_LOADS: Mutex<VecDeque<PendingLoad>> = Mutex::new(VecDeque::new());

#[derive(Clone)]
pub(crate) struct PendingLoad {
    pub seq: u64,
    pub path: String,
}

fn next_load_seq() -> u64 {
    NEXT_LOAD_SEQ.fetch_add(1, Ordering::SeqCst) + 1
}

fn normalize_load_seq(seq: Option<f64>) -> u64 {
    seq.filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.round() as u64)
        .unwrap_or_else(next_load_seq)
}

fn enqueue_pending_load(seq: u64, path: &str) {
    if let Ok(mut loads) = PENDING_LOADS.lock() {
        loads.clear();
        loads.push_back(PendingLoad {
            seq,
            path: path.to_string(),
        });
    }
}

fn remove_pending_load(seq: u64) {
    if let Ok(mut loads) = PENDING_LOADS.lock() {
        if let Some(index) = loads.iter().position(|load| load.seq == seq) {
            loads.remove(index);
        }
    }
}

pub(crate) fn take_pending_load(loaded_path: &str) -> Option<PendingLoad> {
    let mut loads = PENDING_LOADS.lock().ok()?;
    if loads.is_empty() {
        return None;
    }
    if !loaded_path.is_empty() {
        if let Some(index) = loads.iter().position(|load| load.path == loaded_path) {
            return loads.remove(index);
        }
        return None;
    }
    loads.pop_front()
}

/// 获取播放器实例
fn get_player() -> napi::Result<Arc<MpvPlayer>> {
    PLAYER
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("failed to acquire lock: {e}")))?
        .as_ref()
        .cloned()
        .ok_or_else(|| napi::Error::from_reason("player not initialized".to_string()))
}

fn get_player_snapshot() -> Result<Arc<MpvPlayer>, String> {
    PLAYER
        .lock()
        .map_err(|e| format!("failed to acquire lock: {e}"))?
        .as_ref()
        .cloned()
        .ok_or_else(|| "player not initialized".to_string())
}

fn with_task_player<T>(
    snapshot: &Result<Arc<MpvPlayer>, String>,
    operation: impl FnOnce(&Arc<MpvPlayer>) -> Result<T, String>,
) -> napi::Result<T> {
    let player = snapshot
        .as_ref()
        .map_err(|e| napi::Error::from_reason(e.clone()))?;
    let _lifecycle = PLAYER_LIFECYCLE
        .read()
        .map_err(|e| napi::Error::from_reason(format!("failed to acquire lifecycle lock: {e}")))?;
    {
        let guard = PLAYER
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("failed to acquire lock: {e}")))?;
        match guard.as_ref() {
            Some(current) if Arc::ptr_eq(current, player) => {}
            _ => {
                return Err(napi::Error::from_reason(
                    "player instance is no longer active".to_string(),
                ));
            }
        }
    }
    operation(player).map_err(|e| napi::Error::from_reason(e))
}

fn destroy_locked() -> napi::Result<()> {
    // 先清除回调
    if let Ok(mut cb) = EVENT_CALLBACK.lock() {
        *cb = None;
    }
    if let Ok(mut loads) = PENDING_LOADS.lock() {
        loads.clear();
    }

    // 取出并销毁播放器
    let player = {
        let mut guard = PLAYER
            .lock()
            .map_err(|e| napi::Error::from_reason(format!("failed to acquire lock: {e}")))?;
        guard.take()
    };

    if let Some(p) = player {
        p.destroy();
    }

    // 等待事件线程结束
    if let Ok(mut guard) = EVENT_THREAD.lock() {
        if let Some(handle) = guard.take() {
            let _ = handle.join();
        }
    }
    if let Ok(mut loads) = PENDING_LOADS.lock() {
        loads.clear();
    }

    Ok(())
}

fn destroy_player() -> napi::Result<()> {
    let _lifecycle = PLAYER_LIFECYCLE
        .write()
        .map_err(|e| napi::Error::from_reason(format!("failed to acquire lifecycle lock: {e}")))?;
    destroy_locked()
}

fn initialize_player(lib_path: String, config: Option<PlayerConfigOptions>) -> napi::Result<()> {
    let _lifecycle = PLAYER_LIFECYCLE
        .write()
        .map_err(|e| napi::Error::from_reason(format!("failed to acquire lifecycle lock: {e}")))?;

    // 先销毁旧实例
    let _ = destroy_locked();

    let lib = unsafe { MpvLib::load(&lib_path) }.map_err(|e| napi::Error::from_reason(e))?;
    let lib = Arc::new(lib);

    // 构建配置
    let mut player_config = MpvPlayerConfig::default();
    if let Some(cfg) = config {
        if let Some(v) = cfg.cache_secs {
            player_config.cache_secs = v;
        }
        if let Some(v) = cfg.demuxer_max_mb {
            player_config.demuxer_max_mb = v;
        }
        if let Some(v) = cfg.demuxer_back_mb {
            player_config.demuxer_back_mb = v;
        }
        if let Some(v) = cfg.audio_buffer_secs {
            player_config.audio_buffer_secs = v;
        }
        if let Some(v) = cfg.network_timeout_secs {
            player_config.network_timeout_secs = v.clamp(1.0, 300.0);
        }
        if let Some(v) = cfg.http_proxy {
            player_config.http_proxy = v;
        }
    }

    let player = unsafe { MpvPlayer::new_with_config(lib, player_config) }
        .map_err(|e| napi::Error::from_reason(e))?;
    player
        .request_log_messages("warn")
        .map_err(|e| napi::Error::from_reason(e))?;
    let player = Arc::new(player);

    let mut guard = PLAYER
        .lock()
        .map_err(|e| napi::Error::from_reason(format!("failed to acquire lock: {e}")))?;
    *guard = Some(player);

    Ok(())
}

/// 通过全局回调发送事件
#[allow(dead_code)]
fn emit_event(event: PlayerEvent) {
    if let Ok(guard) = EVENT_CALLBACK.lock() {
        if let Some(cb_arc) = guard.as_ref() {
            if let Ok(cb) = cb_arc.lock() {
                cb.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

/// 获取回调的 Arc 引用（供 fade 线程使用）
fn get_callback_arc() -> Option<Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>> {
    EVENT_CALLBACK
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned())
}

/// 播放器配置选项（可选参数）
#[napi(object)]
pub struct PlayerConfigOptions {
    pub cache_secs: Option<u32>,
    pub demuxer_max_mb: Option<u32>,
    pub demuxer_back_mb: Option<u32>,
    pub audio_buffer_secs: Option<f64>,
    pub network_timeout_secs: Option<f64>,
    pub http_proxy: Option<String>,
}

/// 初始化 libmpv 播放器
#[napi]
pub fn initialize(lib_path: String, config: Option<PlayerConfigOptions>) -> napi::Result<()> {
    initialize_player(lib_path, config)
}

/// 销毁播放器
#[napi]
pub fn destroy() -> napi::Result<()> {
    destroy_player()
}

/// 注册事件回调并启动事件循环
#[napi]
pub fn register_event_handler(callback: ThreadsafeFunction<PlayerEvent>) -> napi::Result<()> {
    let player = get_player()?;

    // 用 Arc<Mutex> 包装回调
    let cb_arc = Arc::new(Mutex::new(callback));

    // 保存全局引用
    if let Ok(mut guard) = EVENT_CALLBACK.lock() {
        *guard = Some(cb_arc.clone());
    }

    // 启动事件循环线程
    let handle = start_event_loop(
        player.lib().clone(),
        player.handle_ptr(),
        player.state().clone(),
        player.shutdown_flag().clone(),
        cb_arc,
    );

    if let Ok(mut guard) = EVENT_THREAD.lock() {
        *guard = Some(handle);
    }

    Ok(())
}

/// 加载音频文件任务（loadfile 命令）
pub struct LoadFileTask {
    player: Result<Arc<MpvPlayer>, String>,
    seq: u64,
    url: String,
}

impl Task for LoadFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| {
            enqueue_pending_load(self.seq, &self.url);
            if let Err(err) = player.load_file(&self.url) {
                remove_pending_load(self.seq);
                return Err(err);
            }
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 加载音频文件，返回 Promise<void>。在工作线程发命令，不阻塞主线程。
#[napi]
pub fn load_file(url: String, seq: Option<f64>) -> AsyncTask<LoadFileTask> {
    AsyncTask::new(LoadFileTask {
        player: get_player_snapshot(),
        seq: normalize_load_seq(seq),
        url,
    })
}

/// 加载 MKV 并选择音轨任务
pub struct LoadMkvTrackTask {
    player: Result<Arc<MpvPlayer>, String>,
    seq: u64,
    url: String,
    track_id: i64,
}

impl Task for LoadMkvTrackTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| {
            enqueue_pending_load(self.seq, &self.url);
            if let Err(err) = player.load_mkv_track(&self.url, self.track_id) {
                remove_pending_load(self.seq);
                return Err(err);
            }
            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 加载 MKV 并选择音轨，返回 Promise<void>。
#[napi]
pub fn load_mkv_track(url: String, track_id: i64, seq: Option<f64>) -> AsyncTask<LoadMkvTrackTask> {
    AsyncTask::new(LoadMkvTrackTask {
        player: get_player_snapshot(),
        seq: normalize_load_seq(seq),
        url,
        track_id,
    })
}

/// 设置音轨 ID（file-loaded 后调用）
#[napi]
pub fn set_audio_track(track_id: i64) -> napi::Result<()> {
    get_player()?
        .set_audio_track(track_id)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置网络超时（秒）
#[napi]
pub fn set_network_timeout(seconds: f64) -> napi::Result<()> {
    get_player()?
        .set_network_timeout(seconds)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置 HTTP 代理，空字符串表示直连
#[napi]
pub fn set_http_proxy(proxy: String) -> napi::Result<()> {
    get_player()?
        .set_http_proxy(&proxy)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置响度归一增益任务。Windows 下 volume-gain 属性设置也可能短暂阻塞，
/// 放到工作线程执行，避免卡住主进程事件循环。
pub struct SetVolumeGainTask {
    player: Result<Arc<MpvPlayer>, String>,
    gain_db: f64,
}

impl Task for SetVolumeGainTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.set_volume_gain(self.gain_db))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 设置响度归一增益（dB），返回 Promise<void>。走 mpv 的 volume-gain 属性，不重建 af 链；
/// 老版 mpv 不支持时 Promise reject，由 JS 层回退到 af 滤镜方式。
#[napi]
pub fn set_volume_gain(gain_db: f64) -> AsyncTask<SetVolumeGainTask> {
    AsyncTask::new(SetVolumeGainTask {
        player: get_player_snapshot(),
        gain_db,
    })
}

/// 获取音轨列表任务
pub struct GetTrackListTask {
    player: Result<Arc<MpvPlayer>, String>,
}

impl Task for GetTrackListTask {
    type Output = Vec<TrackInfo>;
    type JsValue = Vec<TrackInfo>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.get_track_list())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// 获取音轨列表，返回 Promise<TrackInfo[]>。track-list 属性读取在工作线程执行。
#[napi]
pub fn get_track_list() -> AsyncTask<GetTrackListTask> {
    AsyncTask::new(GetTrackListTask {
        player: get_player_snapshot(),
    })
}

/// 播放任务（开始播放新文件时会构建 afir 卷积链，可能耗时；放到工作线程执行）
pub struct PlayTask {
    player: Result<Arc<MpvPlayer>, String>,
}

impl Task for PlayTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.play())
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 播放，返回 Promise<void>。新文件起播的滤镜链构建在工作线程完成，不阻塞主线程。
#[napi]
pub fn play() -> AsyncTask<PlayTask> {
    AsyncTask::new(PlayTask {
        player: get_player_snapshot(),
    })
}

/// 暂停
#[napi]
pub fn pause() -> napi::Result<()> {
    get_player()?
        .pause()
        .map_err(|e| napi::Error::from_reason(e))
}

/// 停止
#[napi]
pub fn stop() -> napi::Result<()> {
    get_player()?
        .stop()
        .map_err(|e| napi::Error::from_reason(e))
}

/// 跳转（秒）
#[napi]
pub fn seek(time: f64) -> napi::Result<()> {
    get_player()?
        .seek(time)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置音量（0-100）
#[napi]
pub fn set_volume(volume: f64) -> napi::Result<()> {
    get_player()?
        .set_volume(volume)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置播放速度任务（改 speed 会让 mpv 重建音频滤镜链；开启 afir/IR 卷积时重建很重，
/// 放到工作线程执行，避免阻塞主线程）
pub struct SetSpeedTask {
    player: Result<Arc<MpvPlayer>, String>,
    speed: f64,
}

impl Task for SetSpeedTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.set_speed(self.speed))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 设置播放速度，返回 Promise<void>。滤镜链重建在工作线程完成，不阻塞主线程。
#[napi]
pub fn set_speed(speed: f64) -> AsyncTask<SetSpeedTask> {
    AsyncTask::new(SetSpeedTask {
        player: get_player_snapshot(),
        speed,
    })
}

/// 设置音频输出设备任务（切设备会重建音频输出，可能阻塞）
pub struct SetAudioDeviceTask {
    player: Result<Arc<MpvPlayer>, String>,
    device_name: String,
}

impl Task for SetAudioDeviceTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| {
            player.set_audio_device(&self.device_name)
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 设置音频输出设备，返回 Promise<void>。设备重建在工作线程执行，不阻塞主线程。
#[napi]
pub fn set_audio_device(device_name: String) -> AsyncTask<SetAudioDeviceTask> {
    AsyncTask::new(SetAudioDeviceTask {
        player: get_player_snapshot(),
        device_name,
    })
}

/// 获取音频设备列表任务（Windows WASAPI 枚举可能耗时数百 ms）
pub struct GetAudioDevicesTask {
    player: Result<Arc<MpvPlayer>, String>,
}

impl Task for GetAudioDevicesTask {
    type Output = Vec<AudioDevice>;
    type JsValue = Vec<AudioDevice>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.get_audio_devices())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// 获取音频设备列表，返回 Promise<AudioDevice[]>。设备枚举在工作线程执行。
#[napi]
pub fn get_audio_devices() -> AsyncTask<GetAudioDevicesTask> {
    AsyncTask::new(GetAudioDevicesTask {
        player: get_player_snapshot(),
    })
}

/// 设置音频滤镜
#[napi]
pub fn set_audio_filter(filter: String) -> napi::Result<()> {
    get_player()?
        .set_audio_filter(&filter)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 异步设置音频滤镜任务：在 libuv 工作线程执行，避免重建 af 滤镜链
/// （尤其 afir 卷积）时阻塞 Node 主线程导致 UI / 系统光标卡顿。
pub struct SetAudioFilterTask {
    player: Result<Arc<MpvPlayer>, String>,
    filter: String,
}

impl Task for SetAudioFilterTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.set_audio_filter(&self.filter))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 异步设置音频滤镜，返回 Promise<void>。滤镜链重建在工作线程完成，
/// 不阻塞主线程，错误通过 Promise reject 抛回 JS 层。
#[napi]
pub fn set_audio_filter_async(filter: String) -> AsyncTask<SetAudioFilterTask> {
    AsyncTask::new(SetAudioFilterTask {
        player: get_player_snapshot(),
        filter,
    })
}

/// 运行时向已加载的 af 滤镜发送命令（如改 amix 权重），不重建整条滤镜链
#[napi]
pub fn af_command(label: String, cmd: String, arg: String, target: String) -> napi::Result<()> {
    get_player()?
        .af_command(&label, &cmd, &arg, &target)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置独占模式任务（切独占会重启音频输出，阻塞）
pub struct SetExclusiveTask {
    player: Result<Arc<MpvPlayer>, String>,
    exclusive: bool,
}

impl Task for SetExclusiveTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.set_exclusive(self.exclusive))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 设置独占模式，返回 Promise<void>。音频输出重启在工作线程执行，不阻塞主线程。
#[napi]
pub fn set_exclusive(exclusive: bool) -> AsyncTask<SetExclusiveTask> {
    AsyncTask::new(SetExclusiveTask {
        player: get_player_snapshot(),
        exclusive,
    })
}

/// 设置 force-media-title
#[napi]
pub fn set_media_title(title: String) -> napi::Result<()> {
    get_player()?
        .set_media_title(&title)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 设置文件循环任务（改 loop-file 同样会让 mpv 重建音频滤镜链；afir 激活时重建很重，
/// 放到工作线程执行，避免阻塞主线程）
pub struct SetLoopFileTask {
    player: Result<Arc<MpvPlayer>, String>,
    value: String,
}

impl Task for SetLoopFileTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| player.set_loop_file(&self.value))
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 设置文件循环（"inf" 无限循环，"no" 不循环），返回 Promise<void>。
#[napi]
pub fn set_loop_file(value: String) -> AsyncTask<SetLoopFileTask> {
    AsyncTask::new(SetLoopFileTask {
        player: get_player_snapshot(),
        value,
    })
}

/// 获取当前状态快照
#[napi]
pub fn get_state() -> napi::Result<PlayerState> {
    Ok(get_player()?.get_state())
}

/// 获取属性值（字符串形式）
#[napi]
pub fn get_property(name: String) -> napi::Result<String> {
    get_player()?
        .get_property(&name)
        .map_err(|e| napi::Error::from_reason(e))
}

/// 淡入淡出
/// 返回后 fade 在后台线程执行，完成时通过事件回调通知
#[napi]
pub fn fade(from: f64, to: f64, duration_ms: f64) -> napi::Result<()> {
    let player = get_player()?;
    let duration = duration_ms as u64;

    if duration == 0 {
        player
            .set_volume(to)
            .map_err(|e| napi::Error::from_reason(e))?;
        return Ok(());
    }

    let seq = player.start_fade(from, to, duration);
    let cb_arc = get_callback_arc();

    let player_clone = player.clone();
    std::thread::Builder::new()
        .name("mpv-fade".to_string())
        .spawn(move || {
            let completed = player_clone.execute_fade(from, to, duration, seq);
            if completed {
                if let Some(cb_arc) = cb_arc {
                    if let Ok(cb) = cb_arc.lock() {
                        cb.call(
                            Ok(PlayerEvent::fade_complete()),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                }
            }
        })
        .map_err(|e| napi::Error::from_reason(format!("failed to spawn fade thread: {e}")))?;

    Ok(())
}

/// 取消当前淡入淡出
#[napi]
pub fn cancel_fade() -> napi::Result<()> {
    get_player()?.cancel_fade();
    Ok(())
}

/// 复合操作：淡出 → 暂停 → 恢复音量
#[napi]
pub fn pause_with_fade(saved_volume: f64, duration_ms: f64) -> napi::Result<()> {
    let player = get_player()?;
    let duration = duration_ms as u64;

    if duration == 0 {
        player.pause().map_err(|e| napi::Error::from_reason(e))?;
        return Ok(());
    }

    let seq = player.start_fade(saved_volume, 0.0, duration);
    let cb_arc = get_callback_arc();

    let player_clone = player.clone();
    std::thread::Builder::new()
        .name("mpv-pause-fade".to_string())
        .spawn(move || {
            let completed = player_clone.execute_fade(saved_volume, 0.0, duration, seq);
            if completed {
                let _ = player_clone.pause();
                let _ = player_clone.set_volume(saved_volume);
            }
            if let Some(cb_arc) = cb_arc {
                if let Ok(cb) = cb_arc.lock() {
                    cb.call(
                        Ok(PlayerEvent::fade_complete()),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                }
            }
        })
        .map_err(|e| napi::Error::from_reason(format!("failed to spawn fade thread: {e}")))?;

    Ok(())
}

/// 复合操作任务：设置音量 0 → 播放 → 淡入。其中 play() 会触发新文件的 afir 卷积链构建
/// （可能数百 ms），放到工作线程执行，避免阻塞主线程；淡入本身仍在独立线程后台进行。
pub struct PlayWithFadeTask {
    player: Result<Arc<MpvPlayer>, String>,
    target_volume: f64,
    duration_ms: f64,
}

impl Task for PlayWithFadeTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        with_task_player(&self.player, |player| {
            let duration = self.duration_ms as u64;
            let target_volume = self.target_volume;

            // 先设置音量为 0 并播放（afir 构建发生在此处，于工作线程执行）
            player.set_volume(0.0)?;
            player.play()?;

            if duration == 0 {
                player.set_volume(target_volume)?;
                return Ok(());
            }

            let seq = player.start_fade(0.0, target_volume, duration);
            let cb_arc = get_callback_arc();

            let player_clone = player.clone();
            std::thread::Builder::new()
                .name("mpv-play-fade".to_string())
                .spawn(move || {
                    let completed = player_clone.execute_fade(0.0, target_volume, duration, seq);
                    if completed {
                        let _ = player_clone.set_volume(target_volume);
                    }
                    if let Some(cb_arc) = cb_arc {
                        if let Ok(cb) = cb_arc.lock() {
                            cb.call(
                                Ok(PlayerEvent::fade_complete()),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                    }
                })
                .map_err(|e| format!("failed to spawn fade thread: {e}"))?;

            Ok(())
        })
    }

    fn resolve(&mut self, _env: Env, _output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(())
    }
}

/// 复合操作：设置音量 0 → 播放 → 淡入，返回 Promise<void>。起播的滤镜链构建在工作线程完成。
#[napi]
pub fn play_with_fade(target_volume: f64, duration_ms: f64) -> AsyncTask<PlayWithFadeTask> {
    AsyncTask::new(PlayWithFadeTask {
        player: get_player_snapshot(),
        target_volume,
        duration_ms,
    })
}

/// 检查 fade 是否正在执行
#[napi]
pub fn is_fading() -> napi::Result<bool> {
    Ok(get_player()?.fade_active().load(Ordering::SeqCst))
}
