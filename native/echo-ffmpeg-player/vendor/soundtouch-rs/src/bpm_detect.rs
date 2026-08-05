use crate::{
    error::{
        Result,
        SoundTouchError,
    },
    fifo::FifoSampleBuffer,
    peak_finder::PeakFinder,
};

pub const MIN_BPM: f32 = 45.0;
pub const MAX_BPM_RANGE: f32 = 200.0;
pub const MAX_BPM_VALID: f32 = 190.0;
pub const TARGET_SRATE: usize = 1000;
pub const XCORR_UPDATE_SEQUENCE: usize = TARGET_SRATE / 5;
pub const MOVING_AVERAGE_N: usize = 15;
pub const XCORR_DECAY_TIME_CONSTANT: f64 = 30.0;
pub const OVERLAP_FACTOR: usize = 4;

#[expect(clippy::unreadable_literal)]
const LPF_COEFFS: [f64; 5] = [
    0.00996655391939,
    -0.01944529148401,
    0.00996655391939,
    1.96867605796247,
    -0.96916387431724,
];

#[derive(Debug, Clone, Copy)]
pub struct Beat {
    pub pos: f32,
    pub strength: f32,
}

struct Iir2Filter {
    coeffs: [f64; 5],
    prev: [f64; 5],
}

impl Iir2Filter {
    const fn new(coeffs: [f64; 5]) -> Self {
        Self {
            coeffs,
            prev: [0.0; 5],
        }
    }

    fn update(&mut self, x: f32) -> f32 {
        self.prev[0] = f64::from(x);
        let mut y = self.prev[0] * self.coeffs[0];

        for i in (1..=4).rev() {
            y = self.coeffs[i].mul_add(self.prev[i], y);
            self.prev[i] = self.prev[i - 1];
        }

        self.prev[3] = y;
        y as f32
    }
}

pub struct BpmDetect {
    channels: usize,
    sample_rate: usize,
    decimate_by: usize,
    decimate_count: usize,
    decimate_sum: f32,

    window_len: usize,
    window_start: usize,

    xcorr: Vec<f32>,
    buffer: FifoSampleBuffer,

    hamw: Vec<f32>,
    hamw2: Vec<f32>,

    pos: usize,
    peak_pos: usize,
    peak_val: f32,
    init_scaler: usize,
    beatcorr_ringbuffpos: usize,
    beatcorr_ringbuff: Vec<f32>,

    beats: Vec<Beat>,
    beat_lpf: Iir2Filter,
}

impl BpmDetect {
    pub fn new(channels: usize, sample_rate: usize) -> Result<Self> {
        if channels == 0 {
            return Err(SoundTouchError::InvalidChannels { provided: channels });
        }

        let decimate_by = sample_rate / TARGET_SRATE;
        if decimate_by == 0 {
            return Err(SoundTouchError::InvalidSampleRate {
                provided: sample_rate,
            });
        }

        let window_len = (60 * sample_rate) / (decimate_by * MIN_BPM as usize);
        let window_start = (60 * sample_rate) / (decimate_by * MAX_BPM_RANGE as usize);

        let mut hamw = vec![0.0; XCORR_UPDATE_SEQUENCE];
        for (i, value) in hamw.iter_mut().enumerate() {
            *value = 0.46f64.mul_add(
                -(2.0 * std::f64::consts::PI * (i as f64) / ((XCORR_UPDATE_SEQUENCE - 1) as f64))
                    .cos(),
                0.54,
            ) as f32;
        }

        let mut hamw2 = vec![0.0; XCORR_UPDATE_SEQUENCE / 2];
        for (i, value) in hamw2.iter_mut().enumerate() {
            *value = 0.46f64.mul_add(
                -(2.0 * std::f64::consts::PI * (i as f64)
                    / ((XCORR_UPDATE_SEQUENCE / 2 - 1) as f64))
                    .cos(),
                0.54,
            ) as f32;
        }

        let mut buffer = FifoSampleBuffer::new(1, 1024 * 1024)?;
        buffer.clear();

        Ok(Self {
            channels,
            sample_rate,
            decimate_by,
            decimate_count: 0,
            decimate_sum: 0.0,

            window_len,
            window_start,

            xcorr: vec![0.0; window_len],
            buffer,

            hamw,
            hamw2,

            pos: 0,
            peak_pos: 0,
            peak_val: 0.0,
            init_scaler: 1,
            beatcorr_ringbuffpos: 0,
            beatcorr_ringbuff: vec![0.0; window_len],

            beats: Vec::with_capacity(250),
            beat_lpf: Iir2Filter::new(LPF_COEFFS),
        })
    }

    pub fn put_samples(&mut self, channels_data: &[impl AsRef<[f32]>]) -> Result<()> {
        if channels_data.is_empty() || channels_data[0].as_ref().is_empty() {
            return Ok(());
        }

        let num_frames = channels_data[0].as_ref().len();
        let mut decimated = Vec::with_capacity(num_frames / self.decimate_by + 1);

        for frame_idx in 0..num_frames {
            for channel_data in channels_data.iter().take(self.channels) {
                self.decimate_sum += channel_data.as_ref()[frame_idx];
            }
            self.decimate_count += 1;

            if self.decimate_count >= self.decimate_by {
                let out = self.decimate_sum / (self.decimate_by * self.channels) as f32;
                decimated.push(out);
                self.decimate_sum = 0.0;
                self.decimate_count = 0;
            }
        }

        if !decimated.is_empty() {
            self.buffer.put_samples(&[&decimated])?;
        }

        let req = (self.window_len + XCORR_UPDATE_SEQUENCE).max(2 * XCORR_UPDATE_SEQUENCE);
        while self.buffer.frames() >= req {
            self.update_xcorr(XCORR_UPDATE_SEQUENCE);
            self.update_beat_pos(XCORR_UPDATE_SEQUENCE / 2);
            let n = XCORR_UPDATE_SEQUENCE / OVERLAP_FACTOR;
            self.buffer.receive_frames(n);
        }
        Ok(())
    }

    fn update_xcorr(&mut self, process_samples: usize) {
        let xcorr_decay = 0.5_f64
            .powf(process_samples as f64 / (XCORR_DECAY_TIME_CONSTANT * TARGET_SRATE as f64))
            as f32;
        let p_buffer = self.buffer.current_data_iter().next().unwrap();

        let mut tmp = vec![0.0; process_samples];
        for i in 0..process_samples {
            tmp[i] = self.hamw[i] * self.hamw[i] * p_buffer[i];
        }

        for offs in self.window_start..self.window_len {
            let mut sum = 0.0;
            let mut i = 0;
            let chunks = process_samples / 8;
            let mut sum_vec = wide::f32x8::ZERO;
            for _ in 0..chunks {
                let v_tmp = wide::f32x8::new(tmp[i..i + 8].try_into().unwrap());
                let v_buf = wide::f32x8::new(p_buffer[i + offs..i + offs + 8].try_into().unwrap());
                sum_vec += v_tmp * v_buf;
                i += 8;
            }
            let sum_arr: [f32; 8] = sum_vec.to_array();
            sum += sum_arr.iter().sum::<f32>();

            for j in i..process_samples {
                sum = tmp[j].mul_add(p_buffer[j + offs], sum);
            }

            self.xcorr[offs] *= xcorr_decay;
            self.xcorr[offs] += sum.abs();
        }
    }

    fn update_beat_pos(&mut self, process_samples: usize) {
        let p_buffer = self.buffer.current_data_iter().next().unwrap();

        let pos_scale = self.decimate_by as f64 / self.sample_rate as f64;
        let reset_dur = (0.12 / pos_scale + 0.5) as usize;

        let mut tmp = vec![0.0; process_samples];
        for i in 0..process_samples {
            tmp[i] = self.hamw2[i] * self.hamw2[i] * p_buffer[i];
        }

        for offs in self.window_start..self.window_len {
            let mut sum = 0.0;
            let mut i = 0;
            let chunks = process_samples / 8;
            let mut sum_vec = wide::f32x8::ZERO;
            for _ in 0..chunks {
                let v_tmp = wide::f32x8::new(tmp[i..i + 8].try_into().unwrap());
                let v_buf = wide::f32x8::new(p_buffer[offs + i..offs + i + 8].try_into().unwrap());
                sum_vec += v_tmp * v_buf;
                i += 8;
            }
            let sum_arr: [f32; 8] = sum_vec.to_array();
            sum += sum_arr.iter().sum::<f32>();

            for j in i..process_samples {
                sum = tmp[j].mul_add(p_buffer[offs + j], sum);
            }

            let pos = (self.beatcorr_ringbuffpos + offs) % self.window_len;
            if sum > 0.0 {
                self.beatcorr_ringbuff[pos] += sum;
            }
        }

        let skipstep = XCORR_UPDATE_SEQUENCE / OVERLAP_FACTOR;

        let mut scale = self.window_len as f32 / (skipstep as f32 * self.init_scaler as f32);
        if scale > 1.0 {
            self.init_scaler += 1;
        } else {
            scale = 1.0;
        }

        for _ in 0..skipstep {
            let mut sum = self.beatcorr_ringbuff[self.beatcorr_ringbuffpos];
            sum -= self.beat_lpf.update(sum);

            if sum > self.peak_val {
                self.peak_val = sum;
                self.peak_pos = self.pos;
            }
            if self.pos > self.peak_pos + reset_dur {
                self.peak_pos += skipstep;
                if self.peak_val > 0.0 {
                    self.beats.push(Beat {
                        pos: (self.peak_pos as f64 * pos_scale) as f32,
                        strength: self.peak_val * scale,
                    });
                }

                self.peak_val = 0.0;
                self.peak_pos = self.pos;
            }

            self.beatcorr_ringbuff[self.beatcorr_ringbuffpos] = 0.0;
            self.pos += 1;
            self.beatcorr_ringbuffpos = (self.beatcorr_ringbuffpos + 1) % self.window_len;
        }
    }

    #[must_use]
    pub fn get_bpm(&self) -> Option<f32> {
        let mut xcorr = self.xcorr.clone();

        let mean_x = xcorr[self.window_start..self.window_len]
            .iter()
            .sum::<f32>()
            / (self.window_len - self.window_start) as f32;
        let mean_i = 0.5 * (self.window_len - 1 + self.window_start) as f64;

        let mut b = 0.0;
        let mut div = 0.0;
        for (i, value) in xcorr
            .iter()
            .enumerate()
            .take(self.window_len)
            .skip(self.window_start)
        {
            let xt = f64::from(*value - mean_x);
            let xi = i as f64 - mean_i;
            b = xt.mul_add(xi, b);
            div += xi * xi;
        }
        b /= div;

        let mut minval = f32::MAX;
        for (i, value) in xcorr
            .iter_mut()
            .enumerate()
            .take(self.window_len)
            .skip(self.window_start)
        {
            *value -= (b * i as f64) as f32;
            if *value < minval {
                minval = *value;
            }
        }

        for value in xcorr
            .iter_mut()
            .take(self.window_len)
            .skip(self.window_start)
        {
            *value -= minval;
        }

        let mut data = vec![0.0; self.window_len];
        let half_n = MOVING_AVERAGE_N / 2;
        for (i, value) in data
            .iter_mut()
            .enumerate()
            .take(self.window_len)
            .skip(self.window_start)
        {
            let i1 = i.saturating_sub(half_n).max(self.window_start);
            let i2 = (i + half_n + 1).min(self.window_len);

            let sum: f64 = xcorr[i1..i2].iter().map(|&val| f64::from(val)).sum();
            *value = (sum / (i2 - i1) as f64) as f32;
        }

        let peak_pos = PeakFinder::detect_peak(&data, self.window_start, self.window_len);

        if peak_pos < 1e-9 {
            return None;
        }

        let coeff = 60.0 * (self.sample_rate as f64 / self.decimate_by as f64);
        let bpm = (coeff / peak_pos) as f32;

        if (MIN_BPM..=MAX_BPM_VALID).contains(&bpm) {
            Some(bpm)
        } else {
            None
        }
    }

    pub fn drain_beats(&mut self) -> impl Iterator<Item = Beat> + '_ {
        self.beats.drain(..)
    }
}
