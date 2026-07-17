use crate::dsp::SampleRing;
use crate::effects::{DspChain, DspSettings};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

pub const TARGET_CHANNELS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaybackSignal {
    TimeUpdate,
    PlaybackEnd,
    Stop,
}

pub struct SharedAudio {
    queue: Mutex<VecDeque<f32>>,
    queue_changed: Condvar,
    queue_capacity: usize,
    pub spectrum_ring: Mutex<SampleRing>,
    pub effects: Mutex<DspChain>,
    pub paused: AtomicBool,
    pub stop: AtomicBool,
    output_stop: AtomicBool,
    output_started: AtomicBool,
    decode_stop: AtomicBool,
    eof: AtomicBool,
    decode_failed: AtomicBool,
    end_reported: AtomicBool,
    pub volume: Mutex<f32>,
    pub sample_rate: u32,
    pub played_samples: AtomicU64,
    last_time_event_samples: AtomicU64,
    interrupt: Mutex<Option<Arc<AtomicBool>>>,
    signal_tx: Mutex<Option<SyncSender<PlaybackSignal>>>,
}

impl SharedAudio {
    pub fn new(sample_rate: u32, buffer_secs: f64, dsp_settings: &DspSettings) -> Self {
        let queue_capacity = ((sample_rate as f64 * buffer_secs) as usize)
            .saturating_mul(TARGET_CHANNELS)
            .max(sample_rate as usize / 10);
        Self {
            queue: Mutex::new(VecDeque::with_capacity(queue_capacity)),
            queue_changed: Condvar::new(),
            queue_capacity,
            spectrum_ring: Mutex::new(SampleRing::new(sample_rate as usize * 2)),
            effects: Mutex::new(DspChain::new(sample_rate, dsp_settings)),
            paused: AtomicBool::new(true),
            stop: AtomicBool::new(false),
            output_stop: AtomicBool::new(false),
            output_started: AtomicBool::new(false),
            decode_stop: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            decode_failed: AtomicBool::new(false),
            end_reported: AtomicBool::new(false),
            volume: Mutex::new(1.0),
            sample_rate,
            played_samples: AtomicU64::new(0),
            last_time_event_samples: AtomicU64::new(0),
            interrupt: Mutex::new(None),
            signal_tx: Mutex::new(None),
        }
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.output_stop.store(true, Ordering::Release);
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.notify_signal(PlaybackSignal::Stop);
        self.queue_changed.notify_all();
    }

    pub fn request_output_stop(&self) {
        self.output_stop.store(true, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.queue_changed.notify_all();
    }

    pub fn prepare_output_restart(&self) {
        if self.stop.load(Ordering::Acquire) {
            return;
        }
        self.output_stop.store(false, Ordering::Release);
        self.output_started.store(false, Ordering::Release);
        self.queue_changed.notify_all();
    }

    pub fn should_stop_output(&self) -> bool {
        self.stop.load(Ordering::Acquire) || self.output_stop.load(Ordering::Acquire)
    }

    pub fn mark_output_started(&self) {
        self.output_started.store(true, Ordering::Release);
    }

    pub fn request_decode_stop(&self) {
        self.decode_stop.store(true, Ordering::Release);
        if let Ok(guard) = self.interrupt.lock() {
            if let Some(interrupt) = guard.as_ref() {
                interrupt.store(true, Ordering::Release);
            }
        }
        self.queue_changed.notify_all();
    }

    pub fn should_stop_decoding(&self) -> bool {
        self.stop.load(Ordering::Acquire) || self.decode_stop.load(Ordering::Acquire)
    }

    pub fn bind_interrupt(&self, interrupt: Arc<AtomicBool>) {
        interrupt.store(false, Ordering::Release);
        if let Ok(mut guard) = self.interrupt.lock() {
            *guard = Some(interrupt);
        }
    }

    pub fn bind_signal_sender(&self, sender: SyncSender<PlaybackSignal>) {
        if let Ok(mut guard) = self.signal_tx.lock() {
            *guard = Some(sender);
        }
    }

    pub fn notify_signal(&self, signal: PlaybackSignal) {
        if let Ok(guard) = self.signal_tx.lock() {
            if let Some(sender) = guard.as_ref() {
                let _ = sender.try_send(signal);
            }
        }
    }

    pub fn push_samples(&self, samples: &[f32]) -> bool {
        let mut offset = 0usize;
        while offset < samples.len() {
            if self.should_stop_decoding() {
                return false;
            }
            let mut queue = match self.queue.lock() {
                Ok(queue) => queue,
                Err(_) => return false,
            };
            while queue.len() >= self.queue_capacity && !self.should_stop_decoding() {
                queue = match self.queue_changed.wait(queue) {
                    Ok(queue) => queue,
                    Err(_) => return false,
                };
            }
            if self.should_stop_decoding() {
                return false;
            }
            let space = self.queue_capacity.saturating_sub(queue.len()).max(1);
            let end = (offset + space).min(samples.len());
            queue.extend(samples[offset..end].iter().copied());
            offset = end;
            drop(queue);
            self.queue_changed.notify_all();
        }
        true
    }

    pub fn pop_into(&self, output: &mut [f32]) -> usize {
        output.fill(0.0);
        let mut consumed_samples = 0usize;
        if let Ok(mut queue) = self.queue.lock() {
            for sample in output.iter_mut() {
                let Some(next) = queue.pop_front() else {
                    break;
                };
                *sample = next;
                consumed_samples += 1;
            }
        }
        if consumed_samples > 0 {
            self.queue_changed.notify_all();
            let consumed_frames = consumed_samples / TARGET_CHANNELS;
            let previous = self
                .played_samples
                .fetch_add(consumed_frames as u64, Ordering::AcqRel);
            let current = previous.saturating_add(consumed_frames as u64);
            self.notify_time_update_if_due(current);
            consumed_frames
        } else {
            0
        }
    }

    fn notify_time_update_if_due(&self, current_samples: u64) {
        let interval = (self.sample_rate as u64 / 5).max(1);
        let mut last = self.last_time_event_samples.load(Ordering::Acquire);
        loop {
            if current_samples.saturating_sub(last) < interval {
                return;
            }
            match self.last_time_event_samples.compare_exchange(
                last,
                current_samples,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.notify_signal(PlaybackSignal::TimeUpdate);
                    return;
                }
                Err(actual) => last = actual,
            }
        }
    }

    pub fn mark_eof(&self) {
        self.eof.store(true, Ordering::Release);
        self.queue_changed.notify_all();
    }

    pub fn mark_decode_failed(&self) {
        self.decode_failed.store(true, Ordering::Release);
    }

    pub fn is_drained(&self) -> bool {
        if !self.eof.load(Ordering::Acquire) {
            return false;
        }
        self.queue
            .lock()
            .map(|queue| queue.is_empty())
            .unwrap_or(true)
    }

    pub fn mark_end_reported(&self) -> bool {
        self.end_reported
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn position_secs(&self) -> f64 {
        self.played_samples.load(Ordering::Acquire) as f64 / self.sample_rate as f64
    }

    pub fn reset_for_decode_resume(&self, position_secs: f64, dsp_settings: &DspSettings) {
        if let Ok(mut queue) = self.queue.lock() {
            queue.clear();
        }
        self.decode_stop.store(false, Ordering::Release);
        self.eof.store(false, Ordering::Release);
        self.decode_failed.store(false, Ordering::Release);
        self.end_reported.store(false, Ordering::Release);
        let position_samples = (position_secs.max(0.0) * self.sample_rate as f64) as u64;
        self.played_samples
            .store(position_samples, Ordering::Release);
        self.last_time_event_samples
            .store(position_samples, Ordering::Release);
        if let Ok(mut ring) = self.spectrum_ring.lock() {
            *ring = SampleRing::new(self.sample_rate as usize * 2);
        }
        if let Ok(mut effects) = self.effects.lock() {
            *effects = DspChain::new(self.sample_rate, dsp_settings);
        }
        self.queue_changed.notify_all();
    }
}

pub struct PlaybackSession {
    pub shared: Arc<SharedAudio>,
    pub output_thread: Option<JoinHandle<()>>,
    pub decode_thread: Option<JoinHandle<Option<crate::decoder::DecoderData>>>,
    pub position_thread: Option<JoinHandle<()>>,
}

impl PlaybackSession {
    pub fn stop_background(self) {
        let _ = std::thread::Builder::new()
            .name("player-session-stop".to_string())
            .spawn(move || self.stop_blocking());
    }

    pub fn stop_blocking(mut self) {
        self.shared.request_stop();
        let decode_thread = self.decode_thread.take();
        let output_thread = self.output_thread.take();
        let position_thread = self.position_thread.take();
        if let Some(handle) = decode_thread {
            let _ = handle.join();
        }
        if let Some(handle) = output_thread {
            let _ = handle.join();
        }
        if let Some(handle) = position_thread {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pop_into_advances_position_by_consumed_frames() {
        let shared = SharedAudio::new(100, 0.1, &DspSettings::default());
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));

        let mut output = [1.0f32; 8];
        let frames = shared.pop_into(&mut output);

        assert_eq!(frames, 2);
        assert_eq!(&output[..4], &[0.1, 0.2, 0.3, 0.4]);
        assert_eq!(&output[4..], &[0.0, 0.0, 0.0, 0.0]);
        assert!((shared.position_secs() - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn eof_is_reported_only_after_buffer_is_drained() {
        let shared = SharedAudio::new(100, 0.1, &DspSettings::default());
        assert!(shared.push_samples(&[0.1, 0.2]));

        shared.mark_eof();
        assert!(!shared.is_drained());

        let mut output = [0.0f32; 2];
        shared.pop_into(&mut output);

        assert!(shared.is_drained());
        assert!(shared.mark_end_reported());
        assert!(!shared.mark_end_reported());
    }

    #[test]
    fn reset_for_decode_resume_clears_buffer_and_sets_position() {
        let shared = SharedAudio::new(100, 0.1, &DspSettings::default());
        assert!(shared.push_samples(&[0.1, 0.2, 0.3, 0.4]));
        shared.mark_eof();

        shared.reset_for_decode_resume(1.25, &DspSettings::default());

        let mut output = [1.0f32; 4];
        assert_eq!(shared.pop_into(&mut output), 0);
        assert_eq!(output, [0.0; 4]);
        assert!((shared.position_secs() - 1.25).abs() < f64::EPSILON);
        assert!(!shared.is_drained());
        assert!(shared.mark_end_reported());
    }
}
