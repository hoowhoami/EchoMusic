use wide::f32x8;

use crate::{
    error::Result,
    fifo::FifoSampleBuffer,
};

const DEFAULT_SEQUENCE_MS: usize = 0;
const DEFAULT_SEEKWINDOW_MS: usize = 0;
const DEFAULT_OVERLAP_MS: usize = 8;

/// Core engine for time-scale modification using the WSOLA algorithm.
pub struct TdStretch {
    channels: usize,
    sample_rate: usize,
    tempo: f64,

    sequence_ms: usize,
    seek_window_ms: usize,
    overlap_ms: usize,

    b_auto_seq_setting: bool,
    b_auto_seek_setting: bool,
    is_beginning: bool,

    overlap_length: usize,
    seek_length: usize,
    seek_window_length: usize,
    sample_req: usize,

    nominal_skip: f64,
    skip_fract: f64,

    /// Flat planar overlap buffer for blending the tail of the previous segment.
    /// Layout: `[C0... | C1... | C2...]` where each block has length `overlap_length`.
    overlap_buffer: Vec<f32>,

    input_buffer: FifoSampleBuffer,
}

impl TdStretch {
    /// Creates a new `TdStretch` instance with the given channels, sample rate, and limit.
    pub fn new(channels: usize, sample_rate: usize, max_frame_limit: usize) -> Result<Self> {
        let mut stretch = Self {
            channels,
            sample_rate,
            tempo: 1.0,
            sequence_ms: 0,
            seek_window_ms: 0,
            overlap_ms: 0,
            b_auto_seq_setting: true,
            b_auto_seek_setting: true,
            is_beginning: true,
            overlap_length: 0,
            seek_length: 0,
            seek_window_length: 0,
            sample_req: 0,
            nominal_skip: 0.0,
            skip_fract: 0.0,
            overlap_buffer: Vec::new(),
            input_buffer: FifoSampleBuffer::new(channels, max_frame_limit)?,
        };
        stretch.set_parameters(
            sample_rate,
            DEFAULT_SEQUENCE_MS,
            DEFAULT_SEEKWINDOW_MS,
            DEFAULT_OVERLAP_MS,
        );
        stretch.set_tempo(1.0);
        Ok(stretch)
    }

    /// Dynamically updates the maximum frame limit for the internal buffer.
    pub const fn set_max_frame_limit(&mut self, limit: usize) {
        self.input_buffer.set_max_frame_limit(limit);
    }

    /// Modifies the channel count and re-initializes memory limits.
    pub fn set_channels(&mut self, channels: usize) -> Result<()> {
        if self.channels != channels {
            self.channels = channels;
            self.input_buffer.set_channels(channels)?;

            let sr = self.sample_rate;
            self.set_parameters(sr, self.sequence_ms, self.seek_window_ms, self.overlap_ms);
        }
        Ok(())
    }

    /// Sets the tempo scale factor and calculates WSOLA step sizes.
    pub fn set_tempo(&mut self, new_tempo: f64) {
        self.tempo = new_tempo;
        self.calculate_sequence_parameters();

        self.nominal_skip = self.tempo * (self.seek_window_length - self.overlap_length) as f64;
        let int_skip = (self.nominal_skip + 0.5) as usize;

        self.sample_req =
            (int_skip + self.overlap_length).max(self.seek_window_length) + self.seek_length;
    }

    /// Adjusts internal parameters. Pass `0` for auto-calculation.
    pub fn set_parameters(
        &mut self,
        sample_rate: usize,
        seq_ms: usize,
        seek_ms: usize,
        overlap_ms: usize,
    ) {
        if sample_rate > 0 {
            self.sample_rate = sample_rate;
        }
        if overlap_ms > 0 {
            self.overlap_ms = overlap_ms;
        }
        if seq_ms > 0 {
            self.sequence_ms = seq_ms;
            self.b_auto_seq_setting = false;
        } else if seq_ms == 0 {
            self.b_auto_seq_setting = true;
        }
        if seek_ms > 0 {
            self.seek_window_ms = seek_ms;
            self.b_auto_seek_setting = false;
        } else if seek_ms == 0 {
            self.b_auto_seek_setting = true;
        }

        self.calculate_sequence_parameters();
        self.calculate_overlap_length(self.overlap_ms);
        self.set_tempo(self.tempo);
    }

    /// Clears the pipeline state, readying it for a new audio stream.
    pub fn clear(&mut self) {
        self.input_buffer.clear();
        self.overlap_buffer.fill(0.0);
        self.is_beginning = true;
        self.skip_fract = 0.0;
    }

    pub const fn input_buffer_mut(&mut self) -> &mut FifoSampleBuffer {
        &mut self.input_buffer
    }

    /// Returns the number of unprocessed frames currently backlogged in the input buffer.
    #[must_use]
    pub const fn input_buffer_frames(&self) -> usize {
        self.input_buffer.frames()
    }

    /// Checks if both buffers are drained.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.input_buffer.is_empty()
    }

    /// Returns the initial delay introduced by the WSOLA algorithm.
    #[must_use]
    pub const fn latency(&self) -> usize {
        self.sample_req
    }

    /// Returns the sequence duration in ms (returns 0 if auto-calculation is active).
    #[must_use]
    pub const fn sequence_ms(&self) -> usize {
        if self.b_auto_seq_setting {
            0
        } else {
            self.sequence_ms
        }
    }

    /// Returns the seek window duration in ms (returns 0 if auto-calculation is active).
    #[must_use]
    pub const fn seek_window_ms(&self) -> usize {
        if self.b_auto_seek_setting {
            0
        } else {
            self.seek_window_ms
        }
    }

    /// Returns the overlap cross-fade duration in ms.
    #[must_use]
    pub const fn overlap_ms(&self) -> usize {
        self.overlap_ms
    }

    /// Dynamically calculates best window sizes based on tempo constraints.
    fn calculate_sequence_parameters(&mut self) {
        let tempo_low = 0.5;
        let tempo_top = 2.0;

        if self.b_auto_seq_setting {
            let seq_at_min = 90.0;
            let seq_at_max = 40.0;
            let k = (seq_at_max - seq_at_min) / (tempo_top - tempo_low);
            let c = seq_at_min - k * tempo_low;
            let mut seq = c + k * self.tempo;
            seq = seq.clamp(seq_at_max, seq_at_min);
            self.sequence_ms = (seq + 0.5) as usize;
        }

        if self.b_auto_seek_setting {
            let seek_at_min = 20.0;
            let seek_at_max = 15.0;
            let k = (seek_at_max - seek_at_min) / (tempo_top - tempo_low);
            let c = seek_at_min - k * tempo_low;
            let mut seek = c + k * self.tempo;
            seek = seek.clamp(seek_at_max, seek_at_min);
            self.seek_window_ms = (seek + 0.5) as usize;
        }

        self.seek_window_length = (self.sample_rate * self.sequence_ms) / 1000;
        if self.seek_window_length < 2 * self.overlap_length {
            self.seek_window_length = 2 * self.overlap_length;
        }
        self.seek_length = (self.sample_rate * self.seek_window_ms) / 1000;
    }

    /// Re-allocates the planar overlap buffer using a single 1D flat layout.
    fn calculate_overlap_length(&mut self, overlap_ms: usize) {
        let mut new_ovl = (self.sample_rate * overlap_ms) / 1000;
        if new_ovl < 16 {
            new_ovl = 16;
        }

        new_ovl -= new_ovl % 8;

        if new_ovl != self.overlap_length {
            self.overlap_length = new_ovl;
            self.overlap_buffer
                .resize(self.channels * self.overlap_length, 0.0);
        }

        self.overlap_buffer.fill(0.0);
    }

    /// Main WSOLA sequential core loop.
    pub fn process_samples(&mut self, dest: &mut FifoSampleBuffer) -> Result<()> {
        while self.input_buffer.frames() >= self.sample_req {
            let mut offset = 0;
            if self.is_beginning {
                self.is_beginning = false;
                let skip = (0.5f64.mul_add(
                    self.seek_length as f64,
                    self.tempo * self.overlap_length as f64,
                ) + 0.5) as usize;
                self.skip_fract -= skip as f64;
                if self.skip_fract <= -self.nominal_skip {
                    self.skip_fract = -self.nominal_skip;
                }
            } else {
                // Find highest correlation slicing point.
                offset = self.seek_best_overlap_position();

                let ovl_len = self.overlap_length;
                let ovl_buf = &self.overlap_buffer;

                self.input_buffer
                    .zip_channels(dest, ovl_len, |c, src_mono, dest_mono| {
                        let src_slice = &src_mono[offset..];
                        let overlap_start = c * ovl_len;
                        let overlap_buf_mono = &ovl_buf[overlap_start..overlap_start + ovl_len];
                        Self::overlap_mono(dest_mono, src_slice, overlap_buf_mono, ovl_len);
                    })?;
                dest.commit_written_frames(self.overlap_length);
                offset += self.overlap_length;
            }
            let seq_len = self.seek_window_length - 2 * self.overlap_length;

            self.input_buffer
                .zip_channels(dest, seq_len, |_c, src_mono, dest_mono| {
                    let copy_start = offset;
                    let copy_end = copy_start + seq_len;
                    dest_mono[..seq_len].copy_from_slice(&src_mono[copy_start..copy_end]);
                })?;

            dest.commit_written_frames(seq_len);
            for (c, input_mono) in self
                .input_buffer
                .current_data_iter()
                .enumerate()
                .take(self.channels)
            {
                let overlap_start = offset + seq_len;
                let overlap_end = overlap_start + self.overlap_length;
                let dest_start = c * self.overlap_length;
                self.overlap_buffer[dest_start..dest_start + self.overlap_length]
                    .copy_from_slice(&input_mono[overlap_start..overlap_end]);
            }

            self.skip_fract += self.nominal_skip;
            let ovl_skip = self.skip_fract.floor() as usize;
            self.skip_fract -= ovl_skip as f64;
            self.input_buffer.receive_frames(ovl_skip);
        }
        Ok(())
    }

    /// 1D Mono Overlap-Add using linear cross-fading.
    fn overlap_mono(dest: &mut [f32], src: &[f32], overlap_buf: &[f32], length: usize) {
        let f_scale = 1.0 / length as f32;
        let mut f1 = 0.0;
        let mut f2 = 1.0;

        for i in 0..length {
            dest[i] = overlap_buf[i].mul_add(f2, src[i] * f1);
            f1 += f_scale;
            f2 -= f_scale;
        }
    }

    /// Fast 1D SIMD Mono cross-correlation mathematically comparing sliding windows.
    fn calculate_cross_correlation_mono(
        mixing_pos: &[f32],
        compare: &[f32],
        length_frames: usize,
    ) -> (f64, f64) {
        assert!(length_frames.is_multiple_of(8));

        let m_slice = &mixing_pos[..length_frames];
        let c_slice = &compare[..length_frames];

        let mut corr_vec = f32x8::ZERO;
        let mut norm_vec = f32x8::ZERO;

        let m_chunks = m_slice.chunks_exact(8);
        let c_chunks = c_slice.chunks_exact(8);

        let m_rem = m_chunks.remainder();
        let c_rem = c_chunks.remainder();

        for (m, c) in m_chunks.zip(c_chunks) {
            let m_val = f32x8::new(m.try_into().unwrap());
            let c_val = f32x8::new(c.try_into().unwrap());

            corr_vec = m_val.mul_add(c_val, corr_vec);
            norm_vec = m_val.mul_add(m_val, norm_vec);
        }

        let mut corr = corr_vec.reduce_add();
        let mut norm = norm_vec.reduce_add();

        for i in 0..m_rem.len() {
            corr = m_rem[i].mul_add(c_rem[i], corr);
            norm = m_rem[i].mul_add(m_rem[i], norm);
        }

        (f64::from(corr), f64::from(norm))
    }

    /// Evaluates similarity iteratively over a window to determine best seamless splice point.
    fn seek_best_overlap_position(&self) -> usize {
        const SCANSTEP: usize = 16;
        const SCANWIND: usize = 8;

        let ref_pos: Vec<_> = self.input_buffer.current_data_iter().collect();
        let length_frames = self.overlap_length;

        let mut best_offs = SCANWIND;
        let mut best_offs2 = SCANWIND;
        let mut best_corr = -1e50_f64;
        let mut best_corr2 = -1e50_f64;

        let heuristic_weight = |i: usize| -> f64 {
            let tmp = (2.0f64.mul_add(i as f64, -(self.seek_length as f64)) - 1.0)
                / self.seek_length as f64;
            (0.25 * tmp).mul_add(-tmp, 1.0)
        };

        let get_combined_corr = |i: usize| -> f64 {
            let mut total_corr = 0.0;
            let mut total_norm = 0.0;
            for (c, ref_mono) in ref_pos.iter().enumerate().take(self.channels) {
                let overlap_start = c * self.overlap_length;
                let overlap_buf_mono =
                    &self.overlap_buffer[overlap_start..overlap_start + self.overlap_length];

                let (c_corr, c_norm) = Self::calculate_cross_correlation_mono(
                    &ref_mono[i..],
                    overlap_buf_mono,
                    length_frames,
                );
                total_corr += c_corr;
                total_norm += c_norm;
            }
            let total_norm_sqrt = if total_norm < 1e-9 {
                1.0
            } else {
                total_norm.sqrt()
            };
            total_corr / total_norm_sqrt
        };

        // Rough Scan
        let end_first_pass = self.seek_length.saturating_sub(SCANWIND + 1);
        let mut i = SCANSTEP;
        while i < end_first_pass {
            let corr = get_combined_corr(i);
            let weighted_corr = (corr + 0.1) * heuristic_weight(i);
            if weighted_corr > best_corr {
                best_corr2 = best_corr;
                best_offs2 = best_offs;
                best_corr = weighted_corr;
                best_offs = i;
            } else if weighted_corr > best_corr2 {
                best_corr2 = weighted_corr;
                best_offs2 = i;
            }
            i += SCANSTEP;
        }

        // Fine Scan 1
        let start1 = best_offs.saturating_sub(SCANWIND);
        let end1 = (best_offs + SCANWIND + 1).min(self.seek_length);
        for i in start1..end1 {
            if i == best_offs {
                continue;
            }
            let corr = get_combined_corr(i);
            let weighted_corr = (corr + 0.1) * heuristic_weight(i);
            if weighted_corr > best_corr {
                best_corr = weighted_corr;
                best_offs = i;
            }
        }

        // Fine Scan 2
        let start2 = best_offs2.saturating_sub(SCANWIND);
        let end2 = (best_offs2 + SCANWIND + 1).min(self.seek_length);
        for i in start2..end2 {
            if i == best_offs2 {
                continue;
            }
            let corr = get_combined_corr(i);
            let weighted_corr = (corr + 0.1) * heuristic_weight(i);
            if weighted_corr > best_corr {
                best_corr = weighted_corr;
                best_offs = i;
            }
        }
        best_offs
    }
}
