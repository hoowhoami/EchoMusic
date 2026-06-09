mod backend;
mod dsp;
mod types;

use crate::backend::{start_loopback, CaptureBackend};
use crate::dsp::{SampleRing, SpectrumAnalyzer};
use crate::types::{
    platform_unsupported_reason, running_status, stopped_status, supported_on_current_platform,
    unavailable_status, AnalyzerOptions, SpectrumFrame, SpectrumOptions, SpectrumStatus,
};
use napi_derive::napi;
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

thread_local! {
    static STATE: RefCell<RuntimeState> = RefCell::new(RuntimeState::new());
}

struct RuntimeState {
    session: Option<CaptureSession>,
    last_status: SpectrumStatus,
}

impl RuntimeState {
    fn new() -> Self {
        Self {
            session: None,
            last_status: stopped_status(),
        }
    }
}

struct CaptureSession {
    backend: CaptureBackend,
    latest_frame: Arc<Mutex<Option<SpectrumFrame>>>,
    stop_flag: Arc<AtomicBool>,
    analyzer_thread: Option<JoinHandle<()>>,
}

impl CaptureSession {
    fn stop(mut self) {
        self.stop_flag.store(true, Ordering::Release);
        if let Some(handle) = self.analyzer_thread.take() {
            let _ = handle.join();
        }
        drop(self.backend);
    }

    fn status(&self) -> SpectrumStatus {
        let mut status = running_status();
        if let Ok(guard) = self.backend.last_error.try_lock() {
            status.reason = guard.clone();
        }
        status
    }
}

#[napi]
pub fn start(options: Option<SpectrumOptions>) -> napi::Result<SpectrumStatus> {
    with_state_mut(|state| {
        if let Some(session) = state.session.take() {
            session.stop();
        }

        if !supported_on_current_platform() {
            let status = unavailable_status(platform_unsupported_reason());
            state.last_status = status.clone();
            return Ok(status);
        }

        let ring = Arc::new(Mutex::new(SampleRing::new(48_000 * 2)));
        let backend = match start_loopback(ring.clone()) {
            Ok(backend) => backend,
            Err(reason) => {
                let status = unavailable_status(reason);
                state.last_status = status.clone();
                return Ok(status);
            }
        };

        let analyzer_options = AnalyzerOptions::from_napi(options, backend.sample_rate);
        let latest_frame = Arc::new(Mutex::new(None));
        let stop_flag = Arc::new(AtomicBool::new(false));
        let analyzer_thread = spawn_analyzer(
            analyzer_options,
            backend.sample_rate,
            ring,
            latest_frame.clone(),
            stop_flag.clone(),
        );

        let session = CaptureSession {
            backend,
            latest_frame,
            stop_flag,
            analyzer_thread: Some(analyzer_thread),
        };

        let status = session.status();
        state.last_status = status.clone();
        state.session = Some(session);
        Ok(status)
    })
}

#[napi]
pub fn stop() -> napi::Result<SpectrumStatus> {
    with_state_mut(|state| {
        if let Some(session) = state.session.take() {
            session.stop();
        }
        let status = stopped_status();
        state.last_status = status.clone();
        Ok(status)
    })
}

#[napi]
pub fn get_status() -> napi::Result<SpectrumStatus> {
    with_state(|state| {
        if let Some(session) = state.session.as_ref() {
            return Ok(session.status());
        }
        Ok(state.last_status.clone())
    })
}

#[napi]
pub fn get_snapshot() -> napi::Result<Option<SpectrumFrame>> {
    with_state(|state| {
        let Some(session) = state.session.as_ref() else {
            return Ok(None);
        };
        let frame = session
            .latest_frame
            .lock()
            .map_err(|err| {
                napi::Error::from_reason(format!("failed to lock spectrum frame: {err}"))
            })?
            .clone();
        Ok(frame)
    })
}

fn with_state<T>(f: impl FnOnce(&RuntimeState) -> napi::Result<T>) -> napi::Result<T> {
    STATE
        .try_with(|cell| {
            let state = cell.try_borrow().map_err(|err| {
                napi::Error::from_reason(format!("failed to borrow spectrum state: {err}"))
            })?;
            f(&state)
        })
        .map_err(|_| napi::Error::from_reason("failed to access spectrum state".to_string()))?
}

fn with_state_mut<T>(f: impl FnOnce(&mut RuntimeState) -> napi::Result<T>) -> napi::Result<T> {
    STATE
        .try_with(|cell| {
            let mut state = cell.try_borrow_mut().map_err(|err| {
                napi::Error::from_reason(format!("failed to borrow spectrum state: {err}"))
            })?;
            f(&mut state)
        })
        .map_err(|_| napi::Error::from_reason("failed to access spectrum state".to_string()))?
}

fn spawn_analyzer(
    options: AnalyzerOptions,
    sample_rate: u32,
    ring: Arc<Mutex<SampleRing>>,
    latest_frame: Arc<Mutex<Option<SpectrumFrame>>>,
    stop_flag: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let fps = options.fps.max(1);
        let frame_interval = Duration::from_millis((1000 / fps as u64).max(1));
        let mut analyzer = SpectrumAnalyzer::new(options, sample_rate);

        while !stop_flag.load(Ordering::Acquire) {
            if let Ok(guard) = ring.lock() {
                guard.latest_into(analyzer.scratch_mut());
            }

            let frame = analyzer.analyze();
            if let Ok(mut guard) = latest_frame.lock() {
                *guard = Some(frame);
            }

            thread::sleep(frame_interval);
        }
    })
}
