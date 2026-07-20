use crate::error::{
    Result,
    SoundTouchError,
};

/// Initial capacity (in frames) allocated per channel.
const INITIAL_CAPACITY: usize = 32;

/// A First-In-First-Out (FIFO) audio buffer based on a Flat Planar Layout.
pub struct FifoSampleBuffer {
    /// A single flat buffer: `[C0... | C1... | C2...]`
    buffer: Vec<f32>,
    /// The memory capacity (in frames) currently allocated *per channel*.
    capacity_per_channel: usize,
    /// Number of valid frames currently residing in the buffer.
    frames_in_buffer: usize,
    /// Read pointer (in frames) shared across all channels.
    buffer_pos: usize,
    /// Number of audio channels.
    channels: usize,
    /// Maximum allowed capacity (in frames) per channel. Prevents OOM by capping allocations.
    max_frame_limit: usize,
}

impl FifoSampleBuffer {
    /// Creates a new FIFO buffer with the specified number of channels and maximum frame limit.
    ///
    /// The `max_frame_limit` is to prevent unbounded memory allocation (e.g., passing an extremely
    /// large chunk with a very slow playback rate).
    pub fn new(channels: usize, max_frame_limit: usize) -> Result<Self> {
        if channels == 0 {
            return Err(SoundTouchError::InvalidChannels { provided: channels });
        }

        let capacity_per_channel = INITIAL_CAPACITY;
        let buffer = vec![0.0; channels * capacity_per_channel];

        Ok(Self {
            buffer,
            capacity_per_channel,
            frames_in_buffer: 0,
            buffer_pos: 0,
            channels,
            max_frame_limit,
        })
    }

    /// Dynamically updates the maximum memory limit (in frames) for the buffer.
    ///
    /// This is recalculated and propagated downward when the sample rate changes
    pub const fn set_max_frame_limit(&mut self, limit: usize) {
        self.max_frame_limit = limit;
    }

    /// Clears the buffer and re-initializes it for a new channel count.
    pub fn set_channels(&mut self, channels: usize) -> Result<()> {
        if channels == 0 {
            return Err(SoundTouchError::InvalidChannels { provided: channels });
        }

        if self.channels != channels {
            self.channels = channels;
            self.capacity_per_channel = INITIAL_CAPACITY;
            self.buffer = vec![0.0; channels * self.capacity_per_channel];
            self.clear();
        }
        Ok(())
    }

    /// Resets the internal pointers.
    pub const fn clear(&mut self) {
        self.frames_in_buffer = 0;
        self.buffer_pos = 0;
    }

    /// Returns the number of valid frames remaining in the buffer.
    #[must_use]
    pub const fn frames(&self) -> usize {
        self.frames_in_buffer
    }

    /// Returns `true` if there are no frames left to read.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.frames_in_buffer == 0
    }

    /// Pushes planar format samples into the tail of the buffer.
    ///
    /// The input must contain exactly one slice per channel, and all slices must have the same
    /// length.
    pub fn put_samples(&mut self, channels_data: &[impl AsRef<[f32]>]) -> Result<()> {
        if channels_data.is_empty() {
            return Ok(());
        }

        if channels_data.len() != self.channels {
            return Err(SoundTouchError::ChannelCountMismatch {
                expected: self.channels,
                provided: channels_data.len(),
            });
        }

        let frames_to_add = channels_data[0].as_ref().len();
        for (i, channel_slice) in channels_data.iter().enumerate().skip(1) {
            let slice = channel_slice.as_ref();
            if slice.len() != frames_to_add {
                return Err(SoundTouchError::PlanarLengthMismatch {
                    expected_len: frames_to_add,
                    mismatched_channel: i,
                    mismatched_len: slice.len(),
                });
            }
        }

        if frames_to_add == 0 {
            return Ok(());
        }

        self.ensure_capacity(self.frames_in_buffer + frames_to_add)?;

        let start_idx = self.buffer_pos + self.frames_in_buffer;
        let end_idx = start_idx + frames_to_add;

        for (i, input_channel) in channels_data.iter().enumerate() {
            let slice = input_channel.as_ref();
            let channel_offset = i * self.capacity_per_channel;
            self.buffer[channel_offset + start_idx..channel_offset + end_idx]
                .copy_from_slice(slice);
        }

        self.frames_in_buffer += frames_to_add;
        Ok(())
    }

    /// Pulls planar format data from the head of the buffer into caller-provided mutable slices.
    ///
    /// # Returns
    /// The number of frames actually read.
    pub fn receive_samples(&mut self, output: &mut [impl AsMut<[f32]>]) -> Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }

        if output.len() != self.channels {
            return Err(SoundTouchError::ChannelCountMismatch {
                expected: self.channels,
                provided: output.len(),
            });
        }

        let requested_frames = output[0].as_mut().len();
        for (i, channel_slice) in output.iter_mut().enumerate().skip(1) {
            let slice = channel_slice.as_mut();
            if slice.len() != requested_frames {
                return Err(SoundTouchError::PlanarLengthMismatch {
                    expected_len: requested_frames,
                    mismatched_channel: i,
                    mismatched_len: slice.len(),
                });
            }
        }

        let frames_to_copy = requested_frames.min(self.frames_in_buffer);
        if frames_to_copy == 0 {
            return Ok(0);
        }

        let start_idx = self.buffer_pos;
        let end_idx = start_idx + frames_to_copy;

        for (i, dest_channel) in output.iter_mut().enumerate() {
            let dest_slice = dest_channel.as_mut();
            let channel_offset = i * self.capacity_per_channel;
            dest_slice[..frames_to_copy].copy_from_slice(
                &self.buffer[channel_offset + start_idx..channel_offset + end_idx],
            );
        }

        self.receive_frames(frames_to_copy);
        Ok(frames_to_copy)
    }

    /// Advances the read cursor by `frames` without copying memory.
    pub fn receive_frames(&mut self, frames: usize) -> usize {
        let frames_to_remove = frames.min(self.frames_in_buffer);
        self.frames_in_buffer -= frames_to_remove;
        self.buffer_pos += frames_to_remove;

        if self.frames_in_buffer == 0 {
            self.buffer_pos = 0;
        }

        frames_to_remove
    }

    /// Returns an iterator over read-only slices representing the currently valid planar data.
    /// Produced in channel order: Channel 0, Channel 1, etc.
    pub fn current_data_iter(&self) -> impl Iterator<Item = &[f32]> {
        let start_idx = self.buffer_pos;
        let end_idx = start_idx + self.frames_in_buffer;
        let cap = self.capacity_per_channel;

        self.buffer
            .chunks_exact(cap)
            .map(move |chunk| &chunk[start_idx..end_idx])
    }

    /// Returns an iterator over mutable slices at the tail of each channel.
    pub fn tail_iter_mut(
        &mut self,
        slack_frames: usize,
    ) -> Result<impl Iterator<Item = &mut [f32]>> {
        self.ensure_capacity(self.frames_in_buffer + slack_frames)?;

        let start_idx = self.buffer_pos + self.frames_in_buffer;
        let cap = self.capacity_per_channel;

        Ok(self
            .buffer
            .chunks_exact_mut(cap)
            .map(move |chunk| &mut chunk[start_idx..]))
    }

    /// Manually updates the number of valid frames after direct memory manipulation via
    /// `tail_iter_mut`.
    pub const fn commit_written_frames(&mut self, frames_written: usize) {
        self.frames_in_buffer += frames_written;
    }

    /// Appends `frames` of silence (zeros) to all channels.
    pub fn add_silence(&mut self, frames: usize) -> Result<()> {
        if frames == 0 {
            return Ok(());
        }
        self.ensure_capacity(self.frames_in_buffer + frames)?;

        let start_idx = self.buffer_pos + self.frames_in_buffer;
        let end_idx = start_idx + frames;

        for chunk in self.buffer.chunks_exact_mut(self.capacity_per_channel) {
            chunk[start_idx..end_idx].fill(0.0);
        }

        self.frames_in_buffer += frames;
        Ok(())
    }

    /// Verifies if `required_frames` fits into the contiguous space at the tail
    fn ensure_capacity(&mut self, required_frames: usize) -> Result<()> {
        if required_frames > self.max_frame_limit {
            return Err(SoundTouchError::CapacityLimitExceeded {
                limit: self.max_frame_limit,
                requested: required_frames,
            });
        }

        let current_end_pos = self.buffer_pos + self.frames_in_buffer;
        let available_space = self.capacity_per_channel - current_end_pos;
        let needed_space = required_frames.saturating_sub(self.frames_in_buffer);

        if available_space >= needed_space {
            return Ok(());
        }

        // Check if a simple rewind (shifting valid data to index 0) resolves the fragmentation
        if self.capacity_per_channel >= required_frames {
            if self.buffer_pos > 0 && self.frames_in_buffer > 0 {
                let start = self.buffer_pos;
                let end = start + self.frames_in_buffer;

                // Copy data within each channel's independent chunk
                for chunk in self.buffer.chunks_exact_mut(self.capacity_per_channel) {
                    chunk.copy_within(start..end, 0);
                }
            }
            self.buffer_pos = 0;
            return Ok(());
        }

        // Hard reallocation & re-striding: The requested frames exceed current physical limits
        let new_capacity = required_frames
            .next_power_of_two()
            .max(self.capacity_per_channel * 2);
        let mut new_buffer = vec![0.0; self.channels * new_capacity];

        // Transfer existing valid data into the new, larger layout
        if self.frames_in_buffer > 0 {
            let start = self.buffer_pos;
            let end = start + self.frames_in_buffer;

            for (old_chunk, new_chunk) in self
                .buffer
                .chunks_exact(self.capacity_per_channel)
                .zip(new_buffer.chunks_exact_mut(new_capacity))
            {
                new_chunk[..self.frames_in_buffer].copy_from_slice(&old_chunk[start..end]);
            }
        }

        self.buffer = new_buffer;
        self.capacity_per_channel = new_capacity;
        self.buffer_pos = 0;

        Ok(())
    }

    /// Strict streaming process interface.
    ///
    /// Guarantees that processing across all channels consumes the same number of input frames,
    /// produces the same number of output frames, and that the evolution of state `S` is
    /// absolutely consistent. Automatically advances internal read/write pointers.
    pub fn process_into_strict<S, F>(
        &mut self,
        dest: &mut Self,
        dest_demand: usize,
        initial_state: S,
        mut kernel: F,
    ) -> Result<S>
    where
        S: PartialEq + Clone,
        F: FnMut(&[f32], &mut [f32], &S) -> (usize, usize, S),
    {
        if self.is_empty() {
            return Ok(initial_state);
        }

        let src_data: Vec<_> = self.current_data_iter().collect();
        let mut dest_tails: Vec<_> = dest.tail_iter_mut(dest_demand)?.collect();

        let mut expected_consumed = None;
        let mut expected_produced = None;
        let mut expected_state = None;

        for (src_mono, dest_mono) in src_data.iter().zip(dest_tails.iter_mut()) {
            let (consumed, produced, new_state) = kernel(src_mono, dest_mono, &initial_state);

            if let Some(ec) = expected_consumed {
                assert_eq!(ec, consumed, "Channel desync: consumed frames mismatch");
            } else {
                expected_consumed = Some(consumed);
            }

            if let Some(ep) = expected_produced {
                assert_eq!(ep, produced, "Channel desync: produced frames mismatch");
            } else {
                expected_produced = Some(produced);
            }

            if let Some(ref es) = expected_state {
                assert!(es == &new_state, "Channel desync: state mismatch");
            } else {
                expected_state = Some(new_state.clone());
            }
        }

        let consumed = expected_consumed.unwrap_or(0);
        let produced = expected_produced.unwrap_or(0);
        let final_state = expected_state.unwrap_or(initial_state);

        self.receive_frames(consumed);
        dest.commit_written_frames(produced);

        Ok(final_state)
    }

    /// Low-level channel pairing interface (stateless, no automatic commit).
    ///
    /// Safely pairs source and destination mono slices, hiding memory layout details.
    /// Primarily used for non-linear time-stretching algorithms (like WSOLA) that
    /// require manual control over frame consumption.
    pub fn zip_channels<F>(&self, dest: &mut Self, dest_demand: usize, mut kernel: F) -> Result<()>
    where
        F: FnMut(usize, &[f32], &mut [f32]),
    {
        let src_data: Vec<_> = self.current_data_iter().collect();
        let mut dest_tails: Vec<_> = dest.tail_iter_mut(dest_demand)?.collect();

        for (c, (src_mono, dest_mono)) in src_data.iter().zip(dest_tails.iter_mut()).enumerate() {
            kernel(c, src_mono, &mut dest_mono[..dest_demand]);
        }

        Ok(())
    }
}
