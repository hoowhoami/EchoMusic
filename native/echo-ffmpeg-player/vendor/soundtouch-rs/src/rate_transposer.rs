use crate::{
    aa_filter::AaFilter,
    error::Result,
    fifo::FifoSampleBuffer,
    interpolate::{
        InterpolationAlgorithm,
        Interpolator,
        InterpolatorState,
    },
};

/// Pitch-shifting resampler node in the DSP pipeline.
pub struct RateTransposer {
    /// Target playback rate.
    rate: f64,
    /// Number of audio channels.
    channels: usize,

    /// Whether the anti-aliasing filter is enabled.
    use_aa_filter: bool,

    /// Interpolation algorithm configuration container.
    interpolator: Interpolator,
    /// Anti-aliasing filter kernel.
    aa_filter: AaFilter,

    /// Planar buffer for receiving external input data.
    input_buffer: FifoSampleBuffer,
    /// Intermediate planar buffer between interpolation and filtering.
    mid_buffer: FifoSampleBuffer,

    /// Maintains the precise fractional phase clock for the stateless interpolator.
    ///
    /// Managed across multi-channel parallel processing to ensure absolute phase locking.
    phase_tracker: InterpolatorState,
}

impl RateTransposer {
    /// Creates a new `RateTransposer` with the specified channels and frame limit.
    pub fn new(channels: usize, max_frame_limit: usize) -> Result<Self> {
        let mut transposer = Self {
            rate: 1.0,
            channels,
            use_aa_filter: true,
            interpolator: Interpolator::default(),
            aa_filter: AaFilter::new(128)?,
            input_buffer: FifoSampleBuffer::new(channels, max_frame_limit)?,
            mid_buffer: FifoSampleBuffer::new(channels, max_frame_limit)?,
            phase_tracker: InterpolatorState::new(),
        };
        transposer.aa_filter.set_length(64)?;
        transposer.set_rate(1.0);
        Ok(transposer)
    }

    /// Dynamically updates the maximum frame limit for all internal buffers.
    pub const fn set_max_frame_limit(&mut self, limit: usize) {
        self.input_buffer.set_max_frame_limit(limit);
        self.mid_buffer.set_max_frame_limit(limit);
    }

    /// Changes the number of channels, clearing all internal buffers dynamically.
    pub fn set_channels(&mut self, channels: usize) -> Result<()> {
        if self.channels != channels {
            self.channels = channels;
            self.input_buffer.set_channels(channels)?;
            self.mid_buffer.set_channels(channels)?;
            self.phase_tracker.reset_phase();
        }
        Ok(())
    }

    /// Sets the resampling rate and automatically recalculates the cutoff frequency
    /// for the anti-aliasing low-pass filter.
    pub fn set_rate(&mut self, new_rate: f64) {
        let clamped_rate = new_rate.clamp(0.001, 1000.0);
        self.rate = clamped_rate;

        self.phase_tracker.set_rate(clamped_rate);
        let cutoff = if clamped_rate > 1.0 {
            0.5 / clamped_rate
        } else {
            0.5 * clamped_rate
        };
        self.aa_filter.set_cutoff_freq(cutoff);
    }

    /// Enables or disables the anti-aliasing filter.
    pub const fn enable_aa_filter(&mut self, enable: bool) {
        self.use_aa_filter = enable;
    }

    /// Sets the interpolation algorithm (Linear, Cubic, Shannon).
    pub const fn set_algorithm(&mut self, algo: InterpolationAlgorithm) {
        self.interpolator = Interpolator::new(algo);
    }

    /// Sets the length (number of taps) of the anti-aliasing filter.
    pub fn set_aa_filter_length(&mut self, length: usize) -> Result<()> {
        self.aa_filter.set_length(length)
    }

    /// Returns the current length of the anti-aliasing filter.
    #[must_use]
    pub const fn aa_filter_length(&self) -> usize {
        self.aa_filter.length()
    }

    /// Flushes the pipeline and resets temporal states.
    pub fn clear(&mut self) -> Result<()> {
        self.input_buffer.clear();
        self.mid_buffer.clear();
        self.phase_tracker.reset_phase();

        // Prefill with silence to compensate for the low-pass filter's group delay
        let prefill = self.latency();
        self.input_buffer.add_silence(prefill)?;
        Ok(())
    }

    /// Returns the inherent processing latency of the transposer in frames.
    #[must_use]
    pub const fn latency(&self) -> usize {
        let mut lat = self.interpolator.latency();
        if self.use_aa_filter {
            lat += self.aa_filter.length() / 2;
        }
        lat
    }

    pub const fn input_buffer_mut(&mut self) -> &mut FifoSampleBuffer {
        &mut self.input_buffer
    }

    /// Returns the number of unprocessed frames backlogged in the input buffer.
    #[must_use]
    pub const fn input_buffer_frames(&self) -> usize {
        self.input_buffer.frames()
    }

    /// Checks if the entire pipeline is currently empty.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.input_buffer.is_empty() && self.mid_buffer.is_empty()
    }

    /// Core pipeline execution.
    pub fn process_samples(&mut self, dest: &mut FifoSampleBuffer) -> Result<()> {
        if self.input_buffer.is_empty() {
            return Ok(());
        }

        if !self.use_aa_filter {
            // Direct interpolation (no filtering)
            Self::do_transpose(
                self.interpolator,
                self.rate,
                &mut self.phase_tracker,
                &mut self.input_buffer,
                dest,
            )?;
            return Ok(());
        }

        if self.rate < 1.0 {
            // Downsampling/Downpitching: Interpolate (stretch) -> Low-pass Filter (remove noise)
            Self::do_transpose(
                self.interpolator,
                self.rate,
                &mut self.phase_tracker,
                &mut self.input_buffer,
                &mut self.mid_buffer,
            )?;
            Self::do_filter(&self.aa_filter, &mut self.mid_buffer, dest)?;
        } else {
            // Upsampling/Uppitching: Low-pass Filter (pre-cut) -> Interpolate (shrink)
            Self::do_filter(
                &self.aa_filter,
                &mut self.input_buffer,
                &mut self.mid_buffer,
            )?;
            Self::do_transpose(
                self.interpolator,
                self.rate,
                &mut self.phase_tracker,
                &mut self.mid_buffer,
                dest,
            )?;
        }
        Ok(())
    }

    /// Stateless, cross-channel, phase-locked interpolation scheduler.
    fn do_transpose(
        interpolator: Interpolator,
        rate: f64,
        global_phase: &mut InterpolatorState,
        src: &mut FifoSampleBuffer,
        dest: &mut FifoSampleBuffer,
    ) -> Result<()> {
        let num_src_frames = src.frames();
        if num_src_frames == 0 {
            return Ok(());
        }

        // Estimate required output frame space; add 8 as a safety margin.
        let size_demand = (num_src_frames as f64 / rate) as usize + 8;
        *global_phase = src.process_into_strict(
            dest,
            size_demand,
            *global_phase,
            |src_mono, dest_mono, state| interpolator.transpose_mono(dest_mono, src_mono, *state),
        )?;
        Ok(())
    }

    /// 1D mono FIR low-pass filter scheduler.
    fn do_filter(
        filter: &AaFilter,
        src: &mut FifoSampleBuffer,
        dest: &mut FifoSampleBuffer,
    ) -> Result<()> {
        let num_src_frames = src.frames();
        if num_src_frames == 0 {
            return Ok(());
        }

        let dest_demand = num_src_frames;
        src.process_into_strict(dest, dest_demand, (), |src_mono, dest_mono, ()| {
            let frames_processed = filter.evaluate_mono(dest_mono, src_mono);
            (frames_processed, frames_processed, ())
        })?;
        Ok(())
    }
}
