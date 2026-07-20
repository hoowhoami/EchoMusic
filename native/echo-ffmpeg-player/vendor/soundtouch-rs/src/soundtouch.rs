use std::f64::consts::LN_2;

use crate::{
    error::{
        Result,
        SoundTouchError,
    },
    fifo::FifoSampleBuffer,
    interpolate::InterpolationAlgorithm,
    rate_transposer::RateTransposer,
    td_stretch::TdStretch,
};

/// Pre-configured parameter sets optimized for different types of audio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SoundTouchPreset {
    /// Optimized for **Music** (Default).
    /// Uses automatically calculated longer windows to maintain chord continuity and bass
    /// frequencies.
    #[default]
    Music,

    /// Optimized for **Speech / Podcasts**.
    /// Uses shorter windows (Sequence: 40ms, Seek: 15ms, Overlap: 8ms) to effectively eliminate
    /// robotic echoes caused by transients and fricatives in human voice.
    Speech,

    /// Custom manual parameters (in milliseconds) for the WSOLA time-stretching engine.
    Custom {
        sequence_ms: usize,
        seek_window_ms: usize,
        overlap_ms: usize,
    },
}

/// A builder to construct and configure a `SoundTouch` instance.
pub struct SoundTouchBuilder {
    channels: usize,
    sample_rate: usize,
    rate: f64,
    tempo: f64,
    pitch: f64,
    aa_filter_enabled: bool,
    aa_filter_length: usize,
    algo: InterpolationAlgorithm,
    preset: SoundTouchPreset,
}

impl SoundTouchBuilder {
    fn new(channels: usize, sample_rate: usize) -> Self {
        Self {
            channels,
            sample_rate,
            rate: 1.0,
            tempo: 1.0,
            pitch: 1.0,
            aa_filter_enabled: true,
            aa_filter_length: 64,
            algo: InterpolationAlgorithm::default(),
            preset: SoundTouchPreset::default(),
        }
    }

    /// Sets the initial playback rate (speed and pitch).
    #[must_use]
    pub const fn rate(mut self, rate: f64) -> Self {
        self.rate = rate;
        self
    }

    /// Sets the initial tempo (speed without affecting pitch).
    #[must_use]
    pub const fn tempo(mut self, tempo: f64) -> Self {
        self.tempo = tempo;
        self
    }

    /// Sets the initial pitch (pitch without affecting duration).
    #[must_use]
    pub const fn pitch(mut self, pitch: f64) -> Self {
        self.pitch = pitch;
        self
    }

    /// Sets the initial pitch in semi-tones (e.g., `12.0` raises it by an octave).
    #[must_use]
    pub fn pitch_semi_tones(self, pitch_semi_tones: f64) -> Self {
        let pitch_octaves = pitch_semi_tones / 12.0;
        let pitch_ratio = f64::exp(std::f64::consts::LN_2 * pitch_octaves);
        self.pitch(pitch_ratio)
    }

    /// Enables or disables the anti-aliasing low-pass filter.
    #[must_use]
    pub const fn aa_filter_enabled(mut self, enabled: bool) -> Self {
        self.aa_filter_enabled = enabled;
        self
    }

    /// Sets the length of the anti-aliasing filter (must be a multiple of 4).
    #[must_use]
    pub const fn aa_filter_length(mut self, length: usize) -> Self {
        self.aa_filter_length = length;
        self
    }

    /// Sets the interpolation algorithm used during resampling.
    #[must_use]
    pub const fn interpolation_algo(mut self, algo: InterpolationAlgorithm) -> Self {
        self.algo = algo;
        self
    }

    /// Applies a preset for the time-stretching engine (e.g., Speech, Music).
    #[must_use]
    pub const fn preset(mut self, preset: SoundTouchPreset) -> Self {
        self.preset = preset;
        self
    }

    /// Consumes the builder and returns a fully initialized `SoundTouch` engine.
    ///
    /// Memory allocation occurs here. Returns an error if channel or sample rate is invalid,
    /// or if the filter length is not a multiple of 4.
    pub fn build(self) -> Result<SoundTouch> {
        let mut st = SoundTouch::internal_new(self.channels, self.sample_rate)?;

        st.rate_transposer.enable_aa_filter(self.aa_filter_enabled);
        st.rate_transposer
            .set_aa_filter_length(self.aa_filter_length)?;
        st.rate_transposer.set_algorithm(self.algo);

        match self.preset {
            SoundTouchPreset::Music => st.td_stretch.set_parameters(0, 0, 0, 8),
            SoundTouchPreset::Speech => st.td_stretch.set_parameters(0, 40, 15, 8),
            SoundTouchPreset::Custom {
                sequence_ms,
                seek_window_ms,
                overlap_ms,
            } => st
                .td_stretch
                .set_parameters(0, sequence_ms, seek_window_ms, overlap_ms),
        }

        st.virtual_rate = self.rate;
        st.virtual_tempo = self.tempo;
        st.virtual_pitch = self.pitch;
        st.calculate_effective_rate_and_tempo();

        Ok(st)
    }
}

/// The main processor for SoundTouch audio tempo, pitch, and rate modifications.
pub struct SoundTouch {
    rate_transposer: RateTransposer,
    td_stretch: TdStretch,

    output_buffer: FifoSampleBuffer,

    channels: usize,
    sample_rate: usize,

    virtual_rate: f64,
    virtual_tempo: f64,
    virtual_pitch: f64,

    effective_rate: f64,
    effective_tempo: f64,
}

impl SoundTouch {
    /// Starts constructing a `SoundTouch` instance using the builder pattern.
    #[must_use]
    pub fn builder(channels: usize, sample_rate: usize) -> SoundTouchBuilder {
        SoundTouchBuilder::new(channels, sample_rate)
    }

    /// Internal instantiation called by the builder.
    fn internal_new(channels: usize, sample_rate: usize) -> Result<Self> {
        if channels == 0 {
            return Err(SoundTouchError::InvalidChannels { provided: channels });
        }
        if sample_rate == 0 {
            return Err(SoundTouchError::InvalidSampleRate {
                provided: sample_rate,
            });
        }

        // Calculate the OOM limit (10 seconds of audio buffer)
        let max_frame_limit = sample_rate * 10;

        let mut st = Self {
            rate_transposer: RateTransposer::new(channels, max_frame_limit)?,
            td_stretch: TdStretch::new(channels, sample_rate, max_frame_limit)?,
            output_buffer: FifoSampleBuffer::new(channels, max_frame_limit)?,
            channels,
            sample_rate,
            virtual_rate: 1.0,
            virtual_tempo: 1.0,
            virtual_pitch: 1.0,
            effective_rate: 1.0,
            effective_tempo: 1.0,
        };
        st.calculate_effective_rate_and_tempo();
        Ok(st)
    }

    /// Dynamically changes the number of channels.
    ///
    /// This clears the internal buffers and resizes the pipeline memory allocation.
    pub fn set_channels(&mut self, channels: usize) -> Result<()> {
        if channels == 0 {
            return Err(SoundTouchError::InvalidChannels { provided: channels });
        }
        if self.channels != channels {
            self.channels = channels;
            self.rate_transposer.set_channels(channels)?;
            self.td_stretch.set_channels(channels)?;
            self.output_buffer.set_channels(channels)?;
        }
        Ok(())
    }

    /// Dynamically changes the base sample rate.
    ///
    /// This adjusts the time-stretching sequence parameters accordingly.
    pub fn set_sample_rate(&mut self, sample_rate: usize) -> Result<()> {
        if sample_rate == 0 {
            return Err(SoundTouchError::InvalidSampleRate {
                provided: sample_rate,
            });
        }

        if self.sample_rate != sample_rate {
            self.sample_rate = sample_rate;
            self.td_stretch.set_parameters(sample_rate, 0, 0, 0);

            let new_limit = sample_rate * 10;
            self.rate_transposer.set_max_frame_limit(new_limit);

            self.td_stretch.set_max_frame_limit(new_limit);
            self.output_buffer.set_max_frame_limit(new_limit);
        }
        Ok(())
    }

    /// Dynamically changes the global playback rate (affects both tempo and pitch).
    pub fn set_rate(&mut self, rate: f64) {
        self.virtual_rate = rate;
        self.calculate_effective_rate_and_tempo();
    }

    /// Dynamically changes the tempo (affects duration without altering pitch).
    pub fn set_tempo(&mut self, tempo: f64) {
        self.virtual_tempo = tempo;
        self.calculate_effective_rate_and_tempo();
    }

    /// Dynamically changes the pitch (affects pitch without altering duration).
    pub fn set_pitch(&mut self, pitch: f64) {
        self.virtual_pitch = pitch;
        self.calculate_effective_rate_and_tempo();
    }

    /// Adjusts the pitch in semi-tones (e.g., `12.0` raises it by an octave).
    pub fn set_pitch_semi_tones(&mut self, pitch_semi_tones: f64) {
        self.set_pitch_octaves(pitch_semi_tones / 12.0);
    }

    /// Adjusts the pitch in octaves (e.g., `1.0` raises it by an octave).
    pub fn set_pitch_octaves(&mut self, pitch_octaves: f64) {
        self.set_pitch(f64::exp(LN_2 * pitch_octaves));
    }

    /// Returns the length (number of taps) of the anti-aliasing filter.
    #[must_use]
    pub const fn aa_filter_length(&self) -> usize {
        self.rate_transposer.aa_filter_length()
    }

    /// Dynamically sets the length of the anti-aliasing filter.
    ///
    /// The length must be a multiple of 4. Longer filters provide cleaner high-frequency
    /// attenuation but incur higher computational cost and latency.
    pub fn set_aa_filter_length(&mut self, length: usize) -> Result<()> {
        self.rate_transposer.set_aa_filter_length(length)
    }

    /// Dynamically enables or disables the anti-aliasing filter.
    pub const fn enable_aa_filter(&mut self, enable: bool) {
        self.rate_transposer.enable_aa_filter(enable);
    }

    /// Dynamically changes the interpolation algorithm.
    pub const fn set_interpolation_algorithm(&mut self, algo: InterpolationAlgorithm) {
        self.rate_transposer.set_algorithm(algo);
    }

    /// Dynamically overrides the WSOLA sequence duration (in milliseconds).
    pub fn set_sequence_ms(&mut self, ms: usize) {
        let seek = self.td_stretch.seek_window_ms();
        let overlap = self.td_stretch.overlap_ms();
        self.td_stretch.set_parameters(0, ms, seek, overlap);
    }

    /// Dynamically overrides the WSOLA seek window duration (in milliseconds).
    pub fn set_seek_window_ms(&mut self, ms: usize) {
        let seq = self.td_stretch.sequence_ms();
        let overlap = self.td_stretch.overlap_ms();
        self.td_stretch.set_parameters(0, seq, ms, overlap);
    }

    /// Dynamically overrides the WSOLA overlap duration (in milliseconds).
    pub fn set_overlap_ms(&mut self, ms: usize) {
        let seq = self.td_stretch.sequence_ms();
        let seek = self.td_stretch.seek_window_ms();
        self.td_stretch.set_parameters(0, seq, seek, ms);
    }

    /// Returns the current WSOLA sequence duration in milliseconds.
    #[must_use]
    pub const fn sequence_ms(&self) -> usize {
        self.td_stretch.sequence_ms()
    }

    /// Returns the current WSOLA seek window duration in milliseconds.
    #[must_use]
    pub const fn seek_window_ms(&self) -> usize {
        self.td_stretch.seek_window_ms()
    }

    /// Returns the current WSOLA overlap duration in milliseconds.
    #[must_use]
    pub const fn overlap_ms(&self) -> usize {
        self.td_stretch.overlap_ms()
    }

    /// Gets the estimated input-to-output frame ratio.
    ///
    /// Useful for estimating how many output frames will be produced given a certain number of
    /// input frames.
    #[must_use]
    pub fn input_output_ratio(&self) -> f64 {
        1.0 / (self.effective_tempo * self.effective_rate)
    }

    /// Gets the number of unprocessed frames currently backlogged in the internal pipeline.
    #[must_use]
    pub const fn unprocessed_frames(&self) -> usize {
        self.td_stretch.input_buffer_frames() + self.rate_transposer.input_buffer_frames()
    }

    /// Returns the number of frames currently available in the output buffer.
    #[must_use]
    pub const fn num_samples(&self) -> usize {
        self.output_buffer.frames()
    }

    /// Returns the active number of channels.
    #[must_use]
    pub const fn channels(&self) -> usize {
        self.channels
    }

    /// Returns the active sample rate.
    #[must_use]
    pub const fn sample_rate(&self) -> usize {
        self.sample_rate
    }

    /// Gets the actual resampling rate applied to the DSP algorithms.
    #[must_use]
    pub const fn effective_rate(&self) -> f64 {
        self.effective_rate
    }

    /// Gets the actual tempo scaling factor applied to the DSP algorithms.
    #[must_use]
    pub const fn effective_tempo(&self) -> f64 {
        self.effective_tempo
    }

    /// Checks whether the entire processing pipeline has been fully drained.
    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.rate_transposer.is_empty() && self.td_stretch.is_empty()
    }

    /// Retrieves the system's total initial latency (in frames).
    ///
    /// Useful for highly precise multi-track timeline alignment.
    #[must_use]
    pub fn initial_latency(&self) -> usize {
        let latency_td = self.td_stretch.latency() as f64;
        let latency_rate = self.rate_transposer.latency() as f64;

        let total_latency = if self.effective_rate <= 1.0 {
            // Down-pitch path: RateTransposer processes first.
            (latency_td + latency_rate) * self.effective_rate
        } else {
            // Up-pitch path: TdStretch processes first.
            latency_td + latency_rate / self.effective_rate
        };

        (total_latency + 0.5) as usize
    }

    /// Flushes all remaining audio from the pipeline and resets states.
    pub fn clear(&mut self) -> Result<()> {
        self.rate_transposer.clear()?;
        self.td_stretch.clear();
        self.output_buffer.clear();
        Ok(())
    }

    /// Pushes planar audio slices into the processing pipeline.
    pub fn put_samples(&mut self, channels_data: &[impl AsRef<[f32]>]) -> Result<()> {
        if self.effective_rate <= 1.0 {
            // Speed/Pitch Down: Input -> RateTransposer -> TdStretch -> Output
            self.rate_transposer
                .input_buffer_mut()
                .put_samples(channels_data)?;
            self.rate_transposer
                .process_samples(self.td_stretch.input_buffer_mut())?;
            self.td_stretch.process_samples(&mut self.output_buffer)?;
        } else {
            // Speed/Pitch Up: Input -> TdStretch -> RateTransposer -> Output
            self.td_stretch
                .input_buffer_mut()
                .put_samples(channels_data)?;
            self.td_stretch
                .process_samples(self.rate_transposer.input_buffer_mut())?;
            self.rate_transposer
                .process_samples(&mut self.output_buffer)?;
        }
        Ok(())
    }

    /// Pulls processed planar audio samples from the pipeline into user-provided mutable slices.
    pub fn receive_samples(&mut self, output: &mut [impl AsMut<[f32]>]) -> Result<usize> {
        self.output_buffer.receive_samples(output)
    }

    /// Flushes any pending data out of the pipeline. Typically called at the end of a stream.
    ///
    /// Fills the group delay gaps with silence.
    pub fn flush(&mut self) -> Result<()> {
        let latency = self.td_stretch.latency() + self.rate_transposer.latency();
        let silence_frames =
            (latency as f64 * self.virtual_tempo * self.virtual_rate).ceil() as usize;

        let silence_vecs = vec![vec![0.0; silence_frames]; self.channels];
        self.put_samples(&silence_vecs)
    }

    /// Recalculates engine parameters based on virtual user inputs.
    fn calculate_effective_rate_and_tempo(&mut self) {
        let new_tempo = self.virtual_tempo / self.virtual_pitch;
        let new_rate = self.virtual_pitch * self.virtual_rate;

        if (self.effective_tempo - new_tempo).abs() > 1e-6 {
            self.effective_tempo = new_tempo;
            self.td_stretch.set_tempo(new_tempo);
        }

        if (self.effective_rate - new_rate).abs() > 1e-6 {
            self.effective_rate = new_rate;
            self.rate_transposer.set_rate(new_rate);
        }
    }
}
