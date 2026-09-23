//! Audio buffer management for streaming.

use std::collections::VecDeque;
use std::sync::Arc;
use airplay_core::AudioFormat;

/// Single frame of PCM audio.
#[derive(Debug, Clone)]
pub struct AudioFrame {
    /// Interleaved PCM samples (i16). Arc-wrapped to avoid expensive clones.
    pub samples: Arc<Vec<i16>>,
    /// Timestamp in samples from start.
    pub timestamp: u64,
}

impl AudioFrame {
    /// Create a new audio frame.
    pub fn new(samples: Vec<i16>, timestamp: u64) -> Self {
        Self {
            samples: Arc::new(samples),
            timestamp
        }
    }

    /// Get number of samples per channel.
    pub fn frame_count(&self, channels: u8) -> usize {
        if channels == 0 {
            return 0;
        }
        self.samples.len() / channels as usize
    }
}

/// Buffer error types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BufferError {
    /// Buffer is full, frame dropped.
    Overflow,
    /// Buffer is empty, underrun occurred.
    Underrun,
}

/// Ring buffer for audio frames.
pub struct AudioBuffer {
    frames: VecDeque<AudioFrame>,
    format: AudioFormat,
    capacity_frames: usize,
    total_samples_written: u64,
    total_samples_read: u64,
}

impl AudioBuffer {
    /// Create new buffer with capacity in milliseconds.
    pub fn new(format: AudioFormat, capacity_ms: u32) -> Self {
        let sample_rate = format.sample_rate.as_hz();
        let samples_per_ms = sample_rate / 1000;
        let capacity_samples = samples_per_ms * capacity_ms;
        let capacity_frames = if format.frames_per_packet > 0 {
            (capacity_samples / format.frames_per_packet) as usize
        } else {
            1
        };

        Self {
            frames: VecDeque::with_capacity(capacity_frames.max(1)),
            format,
            capacity_frames: capacity_frames.max(1),
            total_samples_written: 0,
            total_samples_read: 0,
        }
    }

    /// Push a frame to the buffer.
    pub fn push(&mut self, frame: AudioFrame) -> Result<(), BufferError> {
        if self.frames.len() >= self.capacity_frames {
            return Err(BufferError::Overflow);
        }

        let sample_count = frame.samples.len() as u64 / self.format.channels as u64;
        self.total_samples_written += sample_count;
        self.frames.push_back(frame);
        Ok(())
    }

    /// Pop the next frame from the buffer.
    pub fn pop(&mut self) -> Option<AudioFrame> {
        let frame = self.frames.pop_front()?;
        let sample_count = frame.samples.len() as u64 / self.format.channels as u64;
        self.total_samples_read += sample_count;
        Some(frame)
    }

    /// Peek at the next frame without removing.
    pub fn peek(&self) -> Option<&AudioFrame> {
        self.frames.front()
    }

    /// Get number of frames in buffer.
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    /// Check if buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    /// Check if buffer is full.
    pub fn is_full(&self) -> bool {
        self.frames.len() >= self.capacity_frames
    }

    /// Get fill level as percentage (0-100).
    pub fn fill_percentage(&self) -> f32 {
        if self.capacity_frames == 0 {
            return 0.0;
        }
        (self.frames.len() as f32 / self.capacity_frames as f32) * 100.0
    }

    /// Get total samples written.
    pub fn total_written(&self) -> u64 {
        self.total_samples_written
    }

    /// Get total samples read.
    pub fn total_read(&self) -> u64 {
        self.total_samples_read
    }

    /// Get buffered duration in milliseconds.
    pub fn buffered_ms(&self) -> u32 {
        let samples = self.frames.len() as u32 * self.format.frames_per_packet;
        let sample_rate = self.format.sample_rate.as_hz();
        if sample_rate == 0 {
            return 0;
        }
        (samples * 1000) / sample_rate
    }

    /// Clear all buffered frames.
    pub fn clear(&mut self) {
        self.frames.clear();
    }

    /// Flush buffer, returning all frames.
    pub fn flush(&mut self) -> Vec<AudioFrame> {
        self.frames.drain(..).collect()
    }

    /// Get the capacity in frames.
    pub fn capacity(&self) -> usize {
        self.capacity_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use airplay_core::codec::{AudioCodec, SampleRate};

    fn test_format() -> AudioFormat {
        AudioFormat {
            codec: AudioCodec::Alac,
            sample_rate: SampleRate::Hz44100,
            bit_depth: 16,
            channels: 2,
            frames_per_packet: 352,
        }
    }

    fn make_frame(timestamp: u64, channels: u8, samples_per_channel: usize) -> AudioFrame {
        AudioFrame::new(
            vec![0i16; samples_per_channel * channels as usize],
            timestamp,
        )
    }

    mod audio_frame {
        use super::*;

        #[test]
        fn stores_samples_and_timestamp() {
            let samples = vec![1i16, 2, 3, 4, 5, 6];
            let frame = AudioFrame::new(samples.clone(), 12345);

            assert_eq!(*frame.samples, samples);
            assert_eq!(frame.timestamp, 12345);
        }

        #[test]
        fn frame_count_stereo() {
            let frame = make_frame(0, 2, 352);
            assert_eq!(frame.frame_count(2), 352);
        }

        #[test]
        fn frame_count_mono() {
            let frame = make_frame(0, 1, 352);
            assert_eq!(frame.frame_count(1), 352);
        }
    }

    mod audio_buffer {
        use super::*;

        #[test]
        fn new_creates_empty_buffer() {
            let buffer = AudioBuffer::new(test_format(), 1000);
            assert!(buffer.is_empty());
            assert_eq!(buffer.len(), 0);
        }

        #[test]
        fn capacity_calculated_from_ms() {
            let format = test_format();
            // 1000ms at 44100 Hz = 44100 samples
            // With 352 samples per packet = 125 frames (approximately)
            let buffer = AudioBuffer::new(format, 1000);
            assert!(buffer.capacity() > 100);
        }

        #[test]
        fn push_adds_frame() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);
            let frame = make_frame(0, 2, 352);

            buffer.push(frame).unwrap();
            assert_eq!(buffer.len(), 1);
            assert!(!buffer.is_empty());
        }

        #[test]
        fn push_overflow_when_full() {
            let format = test_format();
            let mut buffer = AudioBuffer::new(format, 10); // Small capacity

            // Fill the buffer
            let capacity = buffer.capacity();
            for i in 0..capacity {
                let frame = make_frame(i as u64, 2, 352);
                buffer.push(frame).unwrap();
            }

            assert!(buffer.is_full());

            // Try to push one more
            let frame = make_frame(capacity as u64, 2, 352);
            let result = buffer.push(frame);
            assert_eq!(result, Err(BufferError::Overflow));
        }

        #[test]
        fn pop_removes_oldest_frame() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            // Push two frames
            let frame1 = AudioFrame::new(vec![1i16; 704], 100);
            let frame2 = AudioFrame::new(vec![2i16; 704], 200);

            buffer.push(frame1).unwrap();
            buffer.push(frame2).unwrap();

            // Pop should return first frame
            let popped = buffer.pop().unwrap();
            assert_eq!(popped.timestamp, 100);
            assert_eq!(popped.samples[0], 1);

            // Second pop should return second frame
            let popped = buffer.pop().unwrap();
            assert_eq!(popped.timestamp, 200);
            assert_eq!(popped.samples[0], 2);
        }

        #[test]
        fn pop_returns_none_when_empty() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);
            assert!(buffer.pop().is_none());
        }

        #[test]
        fn peek_does_not_remove() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);
            let frame = AudioFrame::new(vec![42i16; 704], 123);

            buffer.push(frame).unwrap();

            // Peek twice should return the same frame
            let peeked1 = buffer.peek().unwrap();
            assert_eq!(peeked1.timestamp, 123);

            let peeked2 = buffer.peek().unwrap();
            assert_eq!(peeked2.timestamp, 123);

            // Buffer should still have the frame
            assert_eq!(buffer.len(), 1);
        }

        #[test]
        fn fifo_ordering() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            // Push frames in order
            for i in 0..5 {
                let frame = AudioFrame::new(vec![i as i16; 704], i as u64);
                buffer.push(frame).unwrap();
            }

            // Pop should return in FIFO order
            for i in 0..5 {
                let frame = buffer.pop().unwrap();
                assert_eq!(frame.timestamp, i as u64);
                assert_eq!(frame.samples[0], i as i16);
            }
        }
    }

    mod buffer_stats {
        use super::*;

        #[test]
        fn len_tracks_frame_count() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            assert_eq!(buffer.len(), 0);

            buffer.push(make_frame(0, 2, 352)).unwrap();
            assert_eq!(buffer.len(), 1);

            buffer.push(make_frame(1, 2, 352)).unwrap();
            assert_eq!(buffer.len(), 2);

            buffer.pop();
            assert_eq!(buffer.len(), 1);
        }

        #[test]
        fn is_empty_when_no_frames() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);
            assert!(buffer.is_empty());

            buffer.push(make_frame(0, 2, 352)).unwrap();
            assert!(!buffer.is_empty());

            buffer.pop();
            assert!(buffer.is_empty());
        }

        #[test]
        fn is_full_at_capacity() {
            let mut buffer = AudioBuffer::new(test_format(), 10);

            let capacity = buffer.capacity();
            for i in 0..capacity {
                assert!(!buffer.is_full());
                buffer.push(make_frame(i as u64, 2, 352)).unwrap();
            }

            assert!(buffer.is_full());
        }

        #[test]
        fn fill_percentage_accurate() {
            let mut buffer = AudioBuffer::new(test_format(), 100);

            assert_eq!(buffer.fill_percentage(), 0.0);

            let capacity = buffer.capacity();
            let half = capacity / 2;

            for i in 0..half {
                buffer.push(make_frame(i as u64, 2, 352)).unwrap();
            }

            let percentage = buffer.fill_percentage();
            // Should be approximately 50%
            assert!(percentage > 40.0 && percentage < 60.0);
        }

        #[test]
        fn total_written_increments() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            assert_eq!(buffer.total_written(), 0);

            // Push a frame with 352 stereo samples (704 total, 352 per channel)
            buffer.push(make_frame(0, 2, 352)).unwrap();
            assert_eq!(buffer.total_written(), 352);

            buffer.push(make_frame(1, 2, 352)).unwrap();
            assert_eq!(buffer.total_written(), 704);
        }

        #[test]
        fn total_read_increments() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            buffer.push(make_frame(0, 2, 352)).unwrap();
            buffer.push(make_frame(1, 2, 352)).unwrap();

            assert_eq!(buffer.total_read(), 0);

            buffer.pop();
            assert_eq!(buffer.total_read(), 352);

            buffer.pop();
            assert_eq!(buffer.total_read(), 704);
        }

        #[test]
        fn buffered_ms_calculation() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            // At 44100 Hz, 352 samples = ~8ms
            buffer.push(make_frame(0, 2, 352)).unwrap();
            let ms = buffer.buffered_ms();
            assert!(ms >= 7 && ms <= 9, "Expected ~8ms, got {}ms", ms);

            // 5 frames = ~40ms
            for i in 1..5 {
                buffer.push(make_frame(i, 2, 352)).unwrap();
            }
            let ms = buffer.buffered_ms();
            assert!(ms >= 35 && ms <= 45, "Expected ~40ms, got {}ms", ms);
        }
    }

    mod buffer_operations {
        use super::*;

        #[test]
        fn clear_removes_all_frames() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            for i in 0..10 {
                buffer.push(make_frame(i, 2, 352)).unwrap();
            }

            assert_eq!(buffer.len(), 10);

            buffer.clear();
            assert!(buffer.is_empty());
            assert_eq!(buffer.len(), 0);
        }

        #[test]
        fn flush_returns_all_frames() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            for i in 0..5 {
                buffer.push(AudioFrame::new(vec![i as i16; 704], i as u64)).unwrap();
            }

            let flushed = buffer.flush();
            assert_eq!(flushed.len(), 5);

            // Verify order
            for (i, frame) in flushed.iter().enumerate() {
                assert_eq!(frame.timestamp, i as u64);
            }
        }

        #[test]
        fn flush_leaves_buffer_empty() {
            let mut buffer = AudioBuffer::new(test_format(), 1000);

            for i in 0..5 {
                buffer.push(make_frame(i, 2, 352)).unwrap();
            }

            buffer.flush();
            assert!(buffer.is_empty());
        }
    }
}
