use std::collections::VecDeque;
use std::fs;

use crate::vhe::VheProcessor;

#[cfg(test)]
use serde::Serialize;

// This processor owns the parameter-driven VPF stages. An optional external impulse response is
// prepared and processed by DspChain's spatial stage immediately before this processor.
const VPF_MAGIC: [u8; 14] = *b"ViPER4WindowsX";
// Mirrored by VPF_SECTION_SIZES in src/main/ipc/settings.ts for pre-download validation.
const SECTION_SIZES: [usize; 4] = [0x170, 0x2e4, 0x2e8, 0x31c];
const FREESTYLE_SECTION: usize = 3;
const MAX_VPF_BYTES: usize = 1024 * 1024;
const EQ_BAND_COUNT: usize = 10;
const EQ_FREQUENCIES: [f32; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1_000.0, 2_000.0, 4_000.0, 8_000.0, 16_000.0,
];

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedVpf {
    pub file_path: String,
    pub params: VpfParams,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct VpfParams {
    pub bass: BassParams,
    pub clarity: ClarityParams,
    pub field: FieldParams,
    pub headphone: HeadphoneParams,
    pub reverb: ReverbParams,
    pub equalizer: EqualizerParams,
    pub compressor: CompressorParams,
    pub playback: PlaybackParams,
    pub crossfeed: CrossfeedParams,
    pub tube_enabled: bool,
    pub output_volume: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct BassParams {
    pub enabled: bool,
    pub mode: i32,
    pub frequency: f32,
    pub gain: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct ClarityParams {
    pub enabled: bool,
    pub mode: i32,
    pub gain: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct FieldParams {
    pub enabled: bool,
    pub widening: f32,
    pub mid_image: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct HeadphoneParams {
    pub enabled: bool,
    pub level: i32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct ReverbParams {
    pub enabled: bool,
    pub room_size: f32,
    pub width: f32,
    pub damping: f32,
    pub wet: f32,
    pub dry: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct EqualizerParams {
    pub enabled: bool,
    pub gains_db: [f32; 10],
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct CompressorParams {
    pub enabled: bool,
    pub threshold: f32,
    pub ratio: f32,
    pub knee: f32,
    pub auto_knee: bool,
    pub gain: f32,
    pub auto_gain: bool,
    pub attack: f32,
    pub auto_attack: bool,
    pub release: f32,
    pub auto_release: bool,
    pub knee_multi: f32,
    pub max_attack: f32,
    pub max_release: f32,
    pub crest: f32,
    pub adapt: f32,
    pub no_clip: bool,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct PlaybackParams {
    pub enabled: bool,
    pub ratio: f32,
    pub volume: f32,
    pub max_scaler: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct CrossfeedParams {
    pub enabled: bool,
    pub preset: u8,
}

pub fn load_vpf(file_path: &str) -> Result<PreparedVpf, String> {
    let metadata =
        fs::metadata(file_path).map_err(|err| format!("failed to inspect VPF: {err}"))?;
    if !metadata.is_file() {
        return Err("VPF path is not a file".to_string());
    }
    if metadata.len() > MAX_VPF_BYTES as u64 {
        return Err("VPF exceeds size limit".to_string());
    }
    let data = fs::read(file_path).map_err(|err| format!("failed to read VPF: {err}"))?;
    let params = parse_vpf(&data)?;
    Ok(PreparedVpf {
        file_path: file_path.to_string(),
        params,
    })
}

pub fn parse_vpf(data: &[u8]) -> Result<VpfParams, String> {
    if data.len() > MAX_VPF_BYTES {
        return Err("VPF exceeds size limit".to_string());
    }
    if data.len() < VPF_MAGIC.len() + SECTION_SIZES.len() || data[..VPF_MAGIC.len()] != VPF_MAGIC {
        return Err("invalid VPF header".to_string());
    }

    let flags = &data[VPF_MAGIC.len()..VPF_MAGIC.len() + SECTION_SIZES.len()];
    if flags.iter().any(|flag| *flag > 1) {
        return Err("invalid VPF section flags".to_string());
    }

    let mut cursor = VPF_MAGIC.len() + SECTION_SIZES.len();
    let mut freestyle = None;
    for (index, size) in SECTION_SIZES.iter().copied().enumerate() {
        if flags[index] == 0 {
            continue;
        }
        let end = cursor
            .checked_add(size)
            .ok_or_else(|| "VPF section overflow".to_string())?;
        if end > data.len() {
            return Err("truncated VPF section".to_string());
        }
        if index == FREESTYLE_SECTION {
            freestyle = Some(&data[cursor..end]);
        }
        cursor = end;
    }
    if cursor != data.len() {
        return Err("VPF has trailing data".to_string());
    }
    let section = freestyle.ok_or_else(|| "VPF has no supported section".to_string())?;
    parse_freestyle(section)
}

fn parse_freestyle(data: &[u8]) -> Result<VpfParams, String> {
    if data.len() != SECTION_SIZES[FREESTYLE_SECTION] {
        return Err("invalid VPF section size".to_string());
    }
    let linear_db = |offset| -> Result<f32, String> {
        let value = read_f32(data, offset)?;
        if value <= 0.0 {
            return Ok(-120.0);
        }
        Ok((20.0 * value.log10()).clamp(-120.0, 24.0))
    };

    let first = linear_db(0x270)?;
    let mut gains_db = [0.0; 10];
    gains_db[0] = first / 3.0;
    gains_db[1] = first;
    for (index, offset) in (0x278..=0x2b0).step_by(8).enumerate() {
        gains_db[index + 2] = linear_db(offset)?;
    }

    let playback_enabled = read_i32(data, 0x2fc)? != 0;
    Ok(VpfParams {
        bass: BassParams {
            enabled: read_bool(data, 0x214)?,
            mode: read_i32(data, 0x218)?,
            frequency: read_i32(data, 0x21c)?.clamp(20, 300) as f32,
            gain: read_f32(data, 0x220)?.clamp(0.0, 8.0),
        },
        clarity: ClarityParams {
            enabled: read_bool(data, 0x224)?,
            mode: read_i32(data, 0x228)?,
            gain: read_f32(data, 0x22c)?.clamp(0.0, 8.0),
        },
        field: FieldParams {
            enabled: read_bool(data, 0x230)?,
            widening: read_f32(data, 0x238)?.clamp(0.0, 2.0),
            mid_image: read_f32(data, 0x23c)?.clamp(0.0, 2.0),
        },
        headphone: HeadphoneParams {
            enabled: read_bool(data, 0x234)?,
            level: read_i32(data, 0x240)?.clamp(0, 4),
        },
        reverb: ReverbParams {
            enabled: read_bool(data, 0x244)?,
            room_size: read_f32(data, 0x248)?.clamp(0.0, 1.0),
            width: read_f32(data, 0x24c)?.clamp(0.0, 1.0),
            damping: read_f32(data, 0x250)?.clamp(0.0, 1.0),
            wet: read_f32(data, 0x264)?.clamp(0.0, 1.0),
            dry: read_f32(data, 0x268)?.clamp(0.0, 1.0),
        },
        equalizer: EqualizerParams {
            enabled: read_bool(data, 0x26c)?,
            gains_db,
        },
        compressor: CompressorParams {
            enabled: read_bool(data, 0x2b8)?,
            threshold: read_f32(data, 0x2d0)?.clamp(0.0, 1.0),
            ratio: read_f32(data, 0x2d4)?.clamp(0.0, 1.0),
            knee: read_f32(data, 0x2d8)?.clamp(0.0, 1.0),
            auto_knee: read_bool(data, 0x2bc)?,
            gain: read_f32(data, 0x2dc)?.clamp(0.0, 1.0),
            auto_gain: read_bool(data, 0x2c0)?,
            attack: read_f32(data, 0x2e0)?.clamp(0.0, 1.0),
            auto_attack: read_bool(data, 0x2c4)?,
            release: read_f32(data, 0x2e4)?.clamp(0.0, 1.0),
            auto_release: read_bool(data, 0x2c8)?,
            knee_multi: read_f32(data, 0x2e8)?.clamp(0.0, 1.0),
            max_attack: read_f32(data, 0x2ec)?.clamp(0.0, 1.0),
            max_release: read_f32(data, 0x2f0)?.clamp(0.0, 1.0),
            crest: read_f32(data, 0x2f4)?.clamp(0.0, 1.0),
            adapt: read_f32(data, 0x2f8)?.clamp(0.0, 1.0),
            no_clip: read_bool(data, 0x2cc)?,
        },
        playback: PlaybackParams {
            enabled: playback_enabled,
            ratio: read_f32(data, 0x300)?.clamp(0.0, 10.0),
            volume: read_f32(data, 0x304)?.clamp(0.0, 10.0),
            max_scaler: read_f32(data, 0x308)?.clamp(0.0, 10.0),
        },
        crossfeed: CrossfeedParams {
            enabled: read_bool(data, 0x30c)?,
            preset: match read_i32(data, 0x310)? as u32 {
                0x005f_028a => 0,
                0x003c_02bc => 1,
                0x002d_02bc => 2,
                _ => 0,
            },
        },
        tube_enabled: read_bool(data, 0x314)?,
        output_volume: read_f32(data, 0x318)?.clamp(0.0, 8.0),
    })
}

fn read_i32(data: &[u8], offset: usize) -> Result<i32, String> {
    let bytes = data
        .get(offset..offset + 4)
        .ok_or_else(|| "truncated VPF field".to_string())?;
    Ok(i32::from_le_bytes(
        bytes.try_into().expect("field length checked"),
    ))
}

fn read_bool(data: &[u8], offset: usize) -> Result<bool, String> {
    Ok(read_i32(data, offset)? != 0)
}

fn read_f32(data: &[u8], offset: usize) -> Result<f32, String> {
    let value = f32::from_bits(read_i32(data, offset)? as u32);
    if !value.is_finite() {
        return Err(format!("VPF contains non-finite field at {offset:#x}"));
    }
    Ok(value)
}

pub struct VpfProcessor {
    params: VpfParams,
    eq: Option<MinimumPhaseEqualizer>,
    bass: BassProcessor,
    clarity: ClarityProcessor,
    compressor: FetCompressor,
    playback: PlaybackGain,
    tube: TubeProcessor,
    headphone: VheProcessor,
    cure: CureProcessor,
    reverb: StereoReverb,
    limiters: [SoftwareLimiter; 2],
}

impl VpfProcessor {
    pub fn new(sample_rate: u32, vpf: &PreparedVpf) -> Self {
        let sample_rate = sample_rate.max(8_000) as f32;
        let eq = if vpf.params.equalizer.enabled {
            Some(MinimumPhaseEqualizer::new(
                sample_rate as u32,
                vpf.params.equalizer.gains_db,
            ))
        } else {
            None
        };
        let bass = BassProcessor::new(sample_rate as u32, &vpf.params.bass);
        let clarity = ClarityProcessor::new(sample_rate as u32, &vpf.params.clarity);
        Self {
            params: vpf.params.clone(),
            eq,
            bass,
            clarity,
            compressor: FetCompressor::new(sample_rate as u32, &vpf.params.compressor),
            playback: PlaybackGain::new(sample_rate as u32, &vpf.params.playback),
            tube: TubeProcessor::new(sample_rate as u32),
            headphone: VheProcessor::new(sample_rate as u32, vpf.params.headphone.level),
            cure: CureProcessor::new(sample_rate as u32, vpf.params.crossfeed.preset),
            reverb: StereoReverb::new(&vpf.params.reverb),
            limiters: std::array::from_fn(|_| SoftwareLimiter::new()),
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) {
        // Every VPF stage is stereo. Do not let an incomplete final frame pass through only some
        // of the chain while the complete frames are processed.
        if !samples.chunks_exact(2).remainder().is_empty() {
            return;
        }
        if self.params.headphone.enabled {
            self.headphone.process(samples);
        }
        if let Some(eq) = &mut self.eq {
            for frame in samples.chunks_exact_mut(2) {
                (frame[0], frame[1]) = eq.process(frame[0], frame[1]);
            }
        }
        if self.params.field.enabled {
            for frame in samples.chunks_exact_mut(2) {
                (frame[0], frame[1]) = colorful_music(
                    frame[0],
                    frame[1],
                    self.params.field.widening,
                    self.params.field.mid_image,
                );
            }
        }
        if self.params.playback.enabled {
            self.playback.process(samples);
        }
        if self.params.compressor.enabled {
            for frame in samples.chunks_exact_mut(2) {
                let gain = self
                    .compressor
                    .process_sidechain(frame[0].abs().max(frame[1].abs()).max(1e-9));
                frame[0] *= gain;
                frame[1] *= gain;
                self.compressor.advance_parameters();
            }
        }
        if self.params.tube_enabled {
            self.tube.process(samples);
        }
        if self.params.bass.enabled {
            self.bass.process(samples);
        }
        if self.params.clarity.enabled {
            self.clarity.process(samples);
        }
        if self.params.crossfeed.enabled {
            self.cure.process(samples);
        }
        for frame in samples.chunks_exact_mut(2) {
            let mut left = frame[0];
            let mut right = frame[1];
            if self.params.reverb.enabled {
                (left, right) = self.reverb.process(left, right);
            }

            // VPF owns its format-defined limiter. The graph-level limiter remains a separate
            // player safety boundary for normalization, tempo and output-device processing.
            frame[0] = self.limiters[0].process(left * self.params.output_volume);
            frame[1] = self.limiters[1].process(right * self.params.output_volume);
        }
    }

    pub fn latency_frames(&self) -> usize {
        // The limiter always contributes its lookahead; VHE waits for its first convolution
        // block when enabled, and PureBassPlus delays the complete dry signal as well.
        let headphone_latency = if self.params.headphone.enabled {
            self.headphone.latency_frames()
        } else {
            0
        };
        headphone_latency + SoftwareLimiter::LOOKAHEAD + self.bass.latency_frames()
    }
}

fn colorful_music(left: f32, right: f32, widening: f32, mid_image: f32) -> (f32, f32) {
    let normalization = 1.0 / (widening + 2.0).max(2.0);
    let middle = mid_image * normalization * (left + right);
    let side = (widening + 1.0) * normalization * (right - left);
    (middle - side, middle + side)
}

#[derive(Clone, Copy, Default)]
struct FirstOrderFilter {
    b0: f32,
    b1: f32,
    a1: f32,
    previous: f32,
}

impl FirstOrderFilter {
    fn high_pass(sample_rate: u32, frequency: f32) -> Self {
        let tangent = (std::f32::consts::PI * frequency / sample_rate.max(1) as f32).tan();
        let b0 = 1.0 / (1.0 + tangent);
        Self {
            b0,
            b1: -b0,
            a1: (1.0 - tangent) / (1.0 + tangent),
            previous: 0.0,
        }
    }

    fn low_pass(sample_rate: u32, frequency: f32) -> Self {
        let tangent = (std::f32::consts::PI * frequency / sample_rate.max(1) as f32).tan();
        Self {
            b0: tangent / (1.0 + tangent),
            b1: tangent / (1.0 + tangent),
            a1: (1.0 - tangent) / (1.0 + tangent),
            previous: 0.0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let history = sample * self.b1;
        let output = self.previous + sample * self.b0;
        self.previous = output * self.a1 + history;
        output
    }
}

struct CureProcessor {
    low_state: [f32; 2],
    high_state: [f32; 2],
    input_state: [f32; 2],
    low_a0: f32,
    low_b1: f32,
    high_a0: f32,
    high_a1: f32,
    high_b1: f32,
    gain: f32,
    high_pass: [FirstOrderFilter; 2],
    low_pass: [[FirstOrderFilter; 3]; 2],
}

impl CureProcessor {
    fn new(sample_rate: u32, preset: u8) -> Self {
        let sample_rate = sample_rate.max(8_000);
        let (cutoff, feedback) = match preset {
            0 => (650.0_f64, 95_u32),
            1 => (700.0_f64, 60_u32),
            _ => (700.0_f64, 45_u32),
        };
        let level = feedback / 10;
        let low_db = f64::from(level) * -5.0 / 6.0 - 3.0;
        let high_db = f64::from(level) / 6.0 - 3.0;
        let low_gain = 10.0_f64.powf(low_db / 20.0);
        let high_gain = 1.0 - 10.0_f64.powf(high_db / 20.0);
        let high_cutoff = cutoff * 2.0_f64.powf((low_db - 20.0 * high_gain.log10()) / 12.0);

        let low_decay = (-2.0 * std::f64::consts::PI * cutoff / f64::from(sample_rate)).exp();
        let high_decay = (-2.0 * std::f64::consts::PI * high_cutoff / f64::from(sample_rate)).exp();
        let protection_cutoff = if sample_rate < 44_100 {
            sample_rate as f32 - 100.0
        } else {
            18_000.0
        };

        Self {
            low_state: [0.0; 2],
            high_state: [0.0; 2],
            input_state: [0.0; 2],
            low_a0: (low_gain * (1.0 - low_decay)) as f32,
            low_b1: low_decay as f32,
            high_a0: (1.0 - high_gain * (1.0 - high_decay)) as f32,
            high_a1: (-high_decay) as f32,
            high_b1: high_decay as f32,
            gain: (1.0 / (1.0 - high_gain + low_gain)) as f32,
            high_pass: std::array::from_fn(|_| FirstOrderFilter::high_pass(sample_rate, 10.0)),
            low_pass: std::array::from_fn(|_| {
                std::array::from_fn(|_| FirstOrderFilter::low_pass(sample_rate, protection_cutoff))
            }),
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            let input = [frame[0], frame[1]];
            for channel in 0..2 {
                self.low_state[channel] =
                    input[channel] * self.low_a0 + self.low_state[channel] * self.low_b1;
                self.high_state[channel] = input[channel] * self.high_a0
                    + self.input_state[channel] * self.high_a1
                    + self.high_state[channel] * self.high_b1;
                self.input_state[channel] = input[channel];
            }
            frame[0] = (self.high_state[0] + self.low_state[1]) * self.gain;
            frame[1] = (self.high_state[1] + self.low_state[0]) * self.gain;

            for channel in 0..2 {
                let mut output = self.high_pass[channel].process(frame[channel]);
                for filter in &mut self.low_pass[channel] {
                    output = filter.process(output);
                }
                frame[channel] = output;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct ClarityHighShelf {
    b0: f64,
    b1: f64,
    b2: f64,
    a0: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl ClarityHighShelf {
    fn new(sample_rate: u32, frequency: f32, linear_gain: f32) -> Self {
        let gain_db = 20.0 * f64::from(linear_gain.max(f32::MIN_POSITIVE)).log10();
        let angle =
            2.0 * std::f64::consts::PI * f64::from(frequency) / f64::from(sample_rate.max(1));
        let sine = angle.sin();
        let cosine = angle.cos();
        let amplitude = (gain_db * 10.0_f64.ln() / 40.0).exp();
        let root = (amplitude * 2.0).sqrt() * sine;
        let shelf = (amplitude - 1.0) * cosine;
        let denominator = amplitude + 1.0 - shelf;
        let normalizer = root + denominator;
        let cosine_sum = (amplitude + 1.0) * cosine;
        let numerator = amplitude + 1.0 + shelf;
        let feedback = amplitude - 1.0 - cosine_sum;
        Self {
            b0: (numerator + root) * amplitude,
            b1: -amplitude * 2.0 * (amplitude - 1.0 + cosine_sum),
            b2: (numerator - root) * amplitude,
            a0: 1.0 / normalizer,
            a1: feedback * 2.0,
            a2: denominator - root,
            ..Self::default()
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let sample = f64::from(sample);
        let output = (self.x1 * self.b1 + sample * self.b0 + self.b2 * self.x2
            - self.y1 * self.a1
            - self.a2 * self.y2)
            * self.a0;
        self.y2 = self.y1;
        self.y1 = output;
        self.x2 = self.x1;
        self.x1 = sample;
        output as f32
    }
}

struct ClarityProcessor {
    mode: i32,
    gain: f32,
    previous_input: [f32; 2],
    natural_low_pass: [FirstOrderFilter; 2],
    ozone: [ClarityHighShelf; 2],
    xhifi_low_pass: [FirstOrderFilter; 2],
    xhifi_high_pass: [[FirstOrderFilter; 3]; 2],
    xhifi_band_low_pass: [[FirstOrderFilter; 3]; 2],
    xhifi_band_high_pass: [[FirstOrderFilter; 3]; 2],
    xhifi_low_delay: [VecDeque<f32>; 2],
    xhifi_band_delay: [VecDeque<f32>; 2],
}

impl ClarityProcessor {
    fn new(sample_rate: u32, params: &ClarityParams) -> Self {
        let sample_rate = sample_rate.max(8_000);
        Self {
            mode: params.mode,
            gain: params.gain,
            previous_input: [0.0; 2],
            natural_low_pass: std::array::from_fn(|_| {
                FirstOrderFilter::low_pass(sample_rate, sample_rate as f32 / 2.0 - 1_000.0)
            }),
            ozone: std::array::from_fn(|_| {
                ClarityHighShelf::new(sample_rate, 8_250.0, params.gain + 1.0)
            }),
            xhifi_low_pass: std::array::from_fn(|_| FirstOrderFilter::low_pass(sample_rate, 120.0)),
            xhifi_high_pass: std::array::from_fn(|_| {
                std::array::from_fn(|_| FirstOrderFilter::high_pass(sample_rate, 1_200.0))
            }),
            xhifi_band_low_pass: std::array::from_fn(|_| {
                std::array::from_fn(|_| FirstOrderFilter::low_pass(sample_rate, 1_200.0))
            }),
            xhifi_band_high_pass: std::array::from_fn(|_| {
                std::array::from_fn(|_| FirstOrderFilter::high_pass(sample_rate, 120.0))
            }),
            xhifi_low_delay: std::array::from_fn(|_| {
                VecDeque::from(vec![0.0; (sample_rate / 200) as usize])
            }),
            xhifi_band_delay: std::array::from_fn(|_| {
                VecDeque::from(vec![0.0; (sample_rate / 400) as usize])
            }),
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        match self.mode {
            0 => self.process_natural(samples),
            1 => self.process_ozone(samples),
            _ => self.process_xhifi(samples),
        }
    }

    fn process_natural(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            for channel in 0..2 {
                let input = frame[channel];
                let sharpened = input + (input - self.previous_input[channel]) * self.gain;
                self.previous_input[channel] = input;
                let filter = &mut self.natural_low_pass[channel];
                let history = sharpened * filter.b1;
                frame[channel] = filter.previous + sharpened * filter.b0;
                // Natural clarity intentionally uses its input in the feedback update. This is
                // part of the mode's transfer function rather than the generic first-order form.
                filter.previous = sharpened * filter.a1 + history;
            }
        }
    }

    fn process_ozone(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            for channel in 0..2 {
                frame[channel] = self.ozone[channel].process(frame[channel]);
            }
        }
    }

    fn process_xhifi(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            for channel in 0..2 {
                let input = frame[channel];
                let low = self.xhifi_low_pass[channel].process(input);

                let mut high = input;
                for filter in &mut self.xhifi_high_pass[channel] {
                    high = filter.process(high);
                }

                let mut band = input;
                for filter in &mut self.xhifi_band_low_pass[channel] {
                    band = filter.process(band);
                }
                for filter in &mut self.xhifi_band_high_pass[channel] {
                    band = filter.process(band);
                }

                self.xhifi_low_delay[channel].push_back(low);
                self.xhifi_band_delay[channel].push_back(band);
                let delayed_low = self.xhifi_low_delay[channel]
                    .pop_front()
                    .unwrap_or_default();
                let delayed_band = self.xhifi_band_delay[channel]
                    .pop_front()
                    .unwrap_or_default();
                let xhifi_gain = self.gain + 1.0;
                frame[channel] = high * xhifi_gain * 1.2 + delayed_band * xhifi_gain + delayed_low;
            }
        }
    }
}

#[derive(Clone, Copy, Default)]
struct DirectBiquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl DirectBiquad {
    fn band_pass(sample_rate: u32, frequency: f32, q: f32) -> Self {
        let omega =
            2.0 * std::f64::consts::PI * f64::from(frequency) / f64::from(sample_rate.max(1));
        let sine = omega.sin();
        let cosine = omega.cos();
        let alpha = sine / f64::from(q + q);
        Self::normalized(
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
            sine * 0.5,
            0.0,
            -sine * 0.5,
        )
    }

    fn low_pass(sample_rate: u32, frequency: f32, q: f32) -> Self {
        let omega =
            2.0 * std::f64::consts::PI * f64::from(frequency) / f64::from(sample_rate.max(1));
        let sine = omega.sin();
        let cosine = omega.cos();
        let alpha = sine / f64::from(q + q);
        Self::normalized(
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
            (1.0 - cosine) * 0.5,
            1.0 - cosine,
            (1.0 - cosine) * 0.5,
        )
    }

    fn high_pass(sample_rate: u32, frequency: f32, q: f32) -> Self {
        let omega =
            2.0 * std::f64::consts::PI * f64::from(frequency) / f64::from(sample_rate.max(1));
        let sine = omega.sin();
        let cosine = omega.cos();
        let alpha = sine / f64::from(q + q);
        Self::normalized(
            1.0 + alpha,
            -2.0 * cosine,
            1.0 - alpha,
            (1.0 + cosine) * 0.5,
            -(1.0 + cosine),
            (1.0 + cosine) * 0.5,
        )
    }

    fn peak_bandwidth(sample_rate: u32, frequency: f32, bandwidth: f32, gain_db: f32) -> Self {
        let omega =
            2.0 * std::f64::consts::PI * f64::from(frequency) / f64::from(sample_rate.max(1));
        let sine = omega.sin();
        let cosine = omega.cos();
        let gain = 10.0_f64.powf(f64::from(gain_db) / 40.0);
        let alpha = (f64::from(bandwidth) * 2.0_f64.ln() * omega / (2.0 * sine)).sinh() * sine;
        Self::normalized(
            1.0 + alpha / gain,
            -2.0 * cosine,
            1.0 - alpha / gain,
            1.0 + alpha * gain,
            -2.0 * cosine,
            1.0 - alpha * gain,
        )
    }

    fn normalized(a0: f64, a1: f64, a2: f64, b0: f64, b1: f64, b2: f64) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: -(a1 / a0),
            a2: -(a2 / a0),
            ..Self::default()
        }
    }

    fn process(&mut self, sample: f32) -> f64 {
        self.process_f64(f64::from(sample))
    }

    fn process_f64(&mut self, sample: f64) -> f64 {
        let output = sample * self.b0
            + self.x1 * self.b1
            + self.x2 * self.b2
            + self.y1 * self.a1
            + self.y2 * self.a2;
        self.x2 = self.x1;
        self.x1 = sample;
        self.y2 = self.y1;
        self.y1 = output;
        output
    }
}

// PureBassPlus uses this phase-shaping response on the complete signal while the low-frequency
// enhancement follows the same 63-frame delay.
const PURE_BASS_COEFFICIENTS: [f32; 63] = [
    -0.002339, -0.002073, -0.001940, -0.001675, -0.001515, -0.001329, -0.001223, -0.001037,
    -0.000904, -0.000851, -0.000532, -0.000851, -0.000106, -0.001010, 0.000558, -0.001435,
    0.001302, -0.001967, 0.002259, -0.002605, 0.003216, -0.003562, 0.004784, -0.005475, 0.007655,
    -0.008506, 0.017622, -0.024639, 0.028679, -0.017303, -0.032507, 0.623321, 0.184702, -0.166867,
    0.025729, -0.078490, -0.015735, -0.041199, -0.023151, -0.031524, -0.020121, -0.024985,
    -0.017303, -0.019616, -0.015018, -0.015204, -0.012838, -0.011881, -0.010951, -0.009516,
    -0.009090, -0.007788, -0.007442, -0.006353, -0.006087, -0.005183, -0.004970, -0.004253,
    -0.003987, -0.003482, -0.003216, -0.002871, -0.002578,
];

struct Fir63 {
    history: [f32; 63],
}

impl Default for Fir63 {
    fn default() -> Self {
        Self { history: [0.0; 63] }
    }
}

impl Fir63 {
    fn process(&mut self, sample: f32) -> f32 {
        self.history.copy_within(0..62, 1);
        self.history[0] = sample;
        let mut output = 0.0;
        for (coefficient, history) in PURE_BASS_COEFFICIENTS.iter().zip(self.history) {
            output += coefficient * history;
        }
        output
    }
}

struct BassProcessor {
    mode: i32,
    gain: f32,
    smoothed_gain: f32,
    smoothing: f32,
    anti_pop: f32,
    sample_rate_period: f32,
    dc_coefficient: f32,
    dc_input: [f32; 2],
    dc_output: [f32; 2],
    low_pass: [DirectBiquad; 2],
    pure_fir: [Fir63; 2],
    pure_input: VecDeque<(f32, f32)>,
    pure_output: VecDeque<(f32, f32)>,
    pure_low: Vec<f32>,
    sub_peak: [DirectBiquad; 2],
    sub_peak_low: [DirectBiquad; 2],
    sub_low_pass: [DirectBiquad; 2],
}

impl BassProcessor {
    const PURE_LATENCY: usize = 63;
    const PURE_BLOCK: usize = 1008;

    fn new(sample_rate: u32, params: &BassParams) -> Self {
        let sample_rate = sample_rate.max(8_000);
        let low_pass = DirectBiquad::low_pass(sample_rate, params.frequency, 0.53);
        let sub_gain = (params.gain * 2.5).max(f32::MIN_POSITIVE);
        let sub_peak =
            DirectBiquad::peak_bandwidth(sample_rate, 44.0, 0.75, 20.0 * sub_gain.log10());
        let sub_peak_low =
            DirectBiquad::peak_bandwidth(sample_rate, 80.0, 0.2, 20.0 * (sub_gain / 8.0).log10());
        let sub_low_pass = DirectBiquad::low_pass(sample_rate, 380.0, 0.6);
        Self {
            mode: params.mode,
            gain: params.gain,
            smoothed_gain: params.gain,
            smoothing: 1.0 - (-1.0 / (0.030 * sample_rate as f32)).exp(),
            anti_pop: 0.0,
            sample_rate_period: 1.0 / sample_rate as f32,
            dc_coefficient: (-2.0 * std::f32::consts::PI * 18.0 / sample_rate as f32).exp(),
            dc_input: [0.0; 2],
            dc_output: [0.0; 2],
            low_pass: [low_pass, low_pass],
            pure_fir: std::array::from_fn(|_| Fir63::default()),
            pure_input: VecDeque::new(),
            pure_output: VecDeque::new(),
            pure_low: vec![0.0; Self::PURE_LATENCY * 2],
            sub_peak: [sub_peak, sub_peak],
            sub_peak_low: [sub_peak_low, sub_peak_low],
            sub_low_pass: [sub_low_pass, sub_low_pass],
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        match self.mode {
            0 => self.process_natural(samples),
            1 => self.process_pure(samples),
            _ => self.process_subwoofer(samples),
        }
    }

    fn latency_frames(&self) -> usize {
        usize::from(self.mode == 1) * Self::PURE_LATENCY
    }

    fn process_natural(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            self.smoothed_gain += (self.gain - self.smoothed_gain) * self.smoothing;
            let bass = [
                self.low_pass[0].process(frame[0]) as f32 * self.smoothed_gain,
                self.low_pass[1].process(frame[1]) as f32 * self.smoothed_gain,
            ];
            self.shape_mix(frame, bass);
        }
    }

    fn process_pure(&mut self, samples: &mut [f32]) {
        let frames = samples.len() / 2;
        self.pure_low.extend_from_slice(samples);
        let low_write_start = self.pure_low.len() / 2 - frames;
        for frame in samples.chunks_exact(2) {
            self.pure_input.push_back((frame[0], frame[1]));
        }
        for (index, frame) in samples.chunks_exact(2).enumerate() {
            self.pure_low[low_write_start + index * 2] = self.low_pass[0].process(frame[0]) as f32;
            self.pure_low[low_write_start + index * 2 + 1] =
                self.low_pass[1].process(frame[1]) as f32;
        }

        while self.pure_input.len() >= Self::PURE_BLOCK {
            for _ in 0..Self::PURE_BLOCK {
                let input = self.pure_input.pop_front().unwrap_or_default();
                self.pure_output.push_back((
                    self.pure_fir[0].process(input.0),
                    self.pure_fir[1].process(input.1),
                ));
            }
        }
        if self.pure_output.len() < frames {
            return;
        }

        for (index, frame) in samples.chunks_exact_mut(2).enumerate() {
            let dry = self.pure_output.pop_front().unwrap_or_default();
            frame[0] = dry.0;
            frame[1] = dry.1;
            let low = [self.pure_low[index * 2], self.pure_low[index * 2 + 1]];
            self.smoothed_gain += (self.gain - self.smoothed_gain) * self.smoothing;
            self.shape_mix(
                frame,
                [low[0] * self.smoothed_gain, low[1] * self.smoothed_gain],
            );
        }
        self.pure_low.drain(..frames * 2);
    }

    fn process_subwoofer(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            for channel in 0..2 {
                let dry = frame[channel];
                let mut shaped = self.sub_peak[channel].process(dry);
                shaped = self.sub_peak_low[channel].process_f64(shaped);
                shaped = self.sub_low_pass[channel].process_f64(shaped - f64::from(dry));
                let target = dry * 0.5 + shaped as f32 * 0.6;
                frame[channel] = dry + self.anti_pop * (target - dry);
            }
            self.advance_anti_pop();
        }
    }

    fn shape_mix(&mut self, frame: &mut [f32], mut bass: [f32; 2]) {
        if self.anti_pop < 1.0 {
            bass[0] *= self.anti_pop;
            bass[1] *= self.anti_pop;
            self.advance_anti_pop();
        }
        for channel in 0..2 {
            bass[channel] = Self::soft_clip(self.dc_block(bass[channel], channel), 0.8);
            frame[channel] = Self::soft_clip(frame[channel] + bass[channel], 0.95);
        }
    }

    fn advance_anti_pop(&mut self) {
        self.anti_pop = (self.anti_pop + self.sample_rate_period).min(1.0);
    }

    fn dc_block(&mut self, input: f32, channel: usize) -> f32 {
        let output =
            self.dc_coefficient * (self.dc_output[channel] + input - self.dc_input[channel]);
        self.dc_input[channel] = input;
        self.dc_output[channel] = output;
        output
    }

    fn soft_clip(sample: f32, knee: f32) -> f32 {
        let drive = sample.abs();
        if drive <= knee {
            return sample;
        }
        let over = drive - knee;
        let shaped = knee + over / (1.0 + over * over).sqrt();
        sample * (shaped / drive)
    }
}

struct HarmonicGenerator {
    coefficients: [f32; 11],
    startup_samples: u32,
    sample_counter: u32,
    last_processed: f64,
    previous_output: f64,
}

impl HarmonicGenerator {
    fn tube() -> Self {
        let harmonics = [0.5_f32, 0.3, 0.12, 0.05, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
        let mut first = [0.0_f32; 11];
        let mut second = [0.0_f32; 11];
        let absolute_sum: f32 = harmonics.iter().map(|value| value.abs()).sum();
        let maximum = harmonics.iter().copied().map(f32::abs).fold(0.0, f32::max);
        let normalization = if absolute_sum > 1.0 {
            1.0 / absolute_sum
        } else {
            1.0
        };
        for index in 0..10 {
            first[index + 1] = harmonics[index] * normalization;
        }

        let mut coefficients = [0.0_f32; 11];
        coefficients[10] = first[10];
        for index in 2..11 {
            for offset in 0..index {
                let temporary = second[index - offset];
                second[index - offset] = coefficients[index - offset];
                coefficients[index - offset] = coefficients[index - offset - 1] * 2.0 - temporary;
            }
            let temporary = first[11 - index] - second[0];
            second[0] = coefficients[0];
            coefficients[0] = temporary;
        }
        for index in 1..11 {
            coefficients[11 - index] = coefficients[10 - index] - second[11 - index];
        }
        coefficients[0] = first[0] * 0.5 - second[0];

        Self {
            coefficients,
            startup_samples: (maximum * 10_000.0) as u32,
            sample_counter: 0,
            last_processed: 0.0,
            previous_output: 0.0,
        }
    }

    fn process(&mut self, sample: f64) -> f64 {
        let previous_last = self.last_processed;
        let mut output = f64::from(self.coefficients[10]);
        for coefficient in self.coefficients[..10].iter().rev() {
            output = sample.mul_add(output, f64::from(*coefficient));
        }
        self.last_processed = output;
        self.previous_output = self.last_processed + self.previous_output * 0.999 - previous_last;
        if self.sample_counter < self.startup_samples {
            self.sample_counter += 1;
            0.0
        } else {
            self.previous_output
        }
    }
}

struct TubeProcessor {
    high_pass: [DirectBiquad; 2],
    harmonic: [HarmonicGenerator; 2],
    low_pass: [DirectBiquad; 2],
}

impl TubeProcessor {
    fn new(sample_rate: u32) -> Self {
        let sample_rate = sample_rate.max(8_000);
        let high_pass = DirectBiquad::high_pass(sample_rate, 120.0, 0.717);
        let low_pass =
            DirectBiquad::low_pass(sample_rate, sample_rate as f32 / 2.0 - 2_000.0, 0.717);
        Self {
            high_pass: [high_pass, high_pass],
            harmonic: std::array::from_fn(|_| HarmonicGenerator::tube()),
            low_pass: [low_pass, low_pass],
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            for channel in 0..2 {
                let dry = frame[channel];
                let high = self.high_pass[channel].process(dry);
                let harmonic = self.harmonic[channel].process(high);
                let shaped = self.low_pass[channel].process_f64(harmonic);
                frame[channel] = dry + shaped as f32;
            }
        }
    }
}

struct PlaybackGain {
    sample_rate: u32,
    ramp_progress: u32,
    ramp_frames: u32,
    ratio_reciprocal: f32,
    volume: f32,
    max_gain: f32,
    current_gain: [f32; 2],
    analyzers: [DirectBiquad; 2],
}

impl PlaybackGain {
    fn new(sample_rate: u32, params: &PlaybackParams) -> Self {
        let sample_rate = sample_rate.max(8_000);
        Self {
            sample_rate,
            ramp_progress: 0,
            ramp_frames: (sample_rate as f32 * 0.4) as u32,
            ratio_reciprocal: 1.0 / (params.ratio + 1.0),
            volume: params.volume,
            max_gain: params.max_scaler,
            current_gain: [1.0; 2],
            analyzers: std::array::from_fn(|_| DirectBiquad::band_pass(sample_rate, 2_200.0, 0.33)),
        }
    }

    fn process(&mut self, samples: &mut [f32]) {
        let frames = samples.len() / 2;
        if frames == 0 {
            return;
        }
        let mut energy = [0.0; 2];
        for frame in samples.chunks_exact(2) {
            for channel in 0..2 {
                let filtered = self.analyzers[channel].process(frame[channel]);
                energy[channel] += filtered * filtered;
            }
        }
        let analyzed = (energy[0].max(energy[1]) / frames as f64).max(1.0e-10);
        self.ramp_progress = self
            .ramp_progress
            .saturating_add(frames as u32)
            .min(self.ramp_frames);
        let ramp = if self.ramp_frames == 0 {
            1.0
        } else {
            f64::from(self.ramp_progress) / f64::from(self.ramp_frames)
        };
        let loudness = analyzed.ln() * f64::from(0.434_294_5_f32) * 10.0 + 23.0;
        let compression = ramp * (loudness * f64::from(self.ratio_reciprocal) - loudness);
        let curvature = compression / 100.0;
        let target = 10.0f64.powf((compression - curvature * curvature * 50.0) / 20.0)
            * f64::from(self.volume);
        let interpolation_frames = frames.max((self.sample_rate / 40) as usize) as f64;

        for channel in 0..2 {
            let mut step = (target - f64::from(self.current_gain[channel])) / interpolation_frames;
            if step >= 0.0 {
                step *= 0.0625;
            }
            for frame in samples.chunks_exact_mut(2) {
                frame[channel] *= self.current_gain[channel];
                self.current_gain[channel] += step as f32;
                self.current_gain[channel] =
                    self.current_gain[channel].clamp(-self.max_gain, self.max_gain);
            }
        }
    }
}

struct FetCompressor {
    auto_knee: bool,
    auto_gain: bool,
    auto_attack: bool,
    auto_release: bool,
    no_clip: bool,
    sample_rate: f32,
    smoothing_coefficient: f32,
    release_smoothed_reduction: f32,
    attack_smoothed_reduction: f32,
    adaptive_gain: f32,
    smoothed_threshold: f32,
    threshold: f32,
    knee: f32,
    smoothed_gain: f32,
    gain: f32,
    ratio: f32,
    running_peak: f32,
    running_rms: f32,
    attack_time: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    knee_multi: f32,
    max_attack: f32,
    max_release: f32,
    crest_coefficient: f32,
    adapt_coefficient: f32,
}

impl FetCompressor {
    fn new(sample_rate: u32, params: &CompressorParams) -> Self {
        let sample_rate = sample_rate.max(8_000) as f32;
        let threshold = (10.0f32.powf(params.threshold * -3.0)).ln();
        let knee = (10.0f32.powf(params.knee * 3.0)).ln();
        let gain = (10.0f32.powf(params.gain * 3.0)).ln();
        let attack_time = (params.attack * 7.600_903 - 9.210_34).exp();
        let release_time = (params.release * 5.991_465 - 5.298_317).exp();
        let crest_time = (params.crest * 5.991_465 - 5.298_317).exp();
        let adapt_time = (params.adapt * 1.386_294).exp();
        Self {
            auto_knee: params.auto_knee,
            auto_gain: params.auto_gain,
            auto_attack: params.auto_attack,
            auto_release: params.auto_release,
            no_clip: params.no_clip,
            sample_rate,
            smoothing_coefficient: fet_time_coefficient(sample_rate, 0.05),
            release_smoothed_reduction: 0.0,
            attack_smoothed_reduction: 0.0,
            adaptive_gain: 0.0,
            // A freshly committed Freestyle preset ramps threshold and gain from the clean
            // compressor defaults over the 50 ms parameter smoothing window.
            smoothed_threshold: 0.0,
            threshold,
            knee,
            smoothed_gain: 0.0,
            gain,
            ratio: -params.ratio,
            running_peak: 0.000_001,
            running_rms: 0.000_001,
            attack_time,
            attack_coefficient: fet_time_coefficient(sample_rate, attack_time),
            release_coefficient: fet_time_coefficient(sample_rate, release_time),
            knee_multi: params.knee_multi * 4.0,
            max_attack: (params.max_attack * 7.600_903 - 9.210_34).exp(),
            max_release: (params.max_release * 5.991_465 - 5.298_317).exp(),
            crest_coefficient: fet_time_coefficient(sample_rate, crest_time),
            adapt_coefficient: fet_time_coefficient(sample_rate, adapt_time),
        }
    }

    fn process_sidechain(&mut self, input: f32) -> f32 {
        let mut squared = (input as f64 * input as f64).max(0.000_001);
        let mut attack_coefficient = self.attack_coefficient;
        let mut release_coefficient = self.release_coefficient;
        let mut adaptive_attack_time = self.attack_time;

        let running_peak =
            self.running_peak + self.crest_coefficient * (squared as f32 - self.running_peak);
        let running_rms =
            self.running_rms + self.crest_coefficient * (squared as f32 - self.running_rms);
        if (squared as f32) < running_peak {
            squared = running_peak as f64;
        }
        self.running_rms = running_rms;
        self.running_peak = squared as f32;
        let crest_ratio = squared as f32 / running_rms;

        if self.auto_attack {
            adaptive_attack_time = 2.0 * self.max_attack / crest_ratio;
            attack_coefficient = if adaptive_attack_time <= 0.0 {
                1.0
            } else {
                fet_time_coefficient(self.sample_rate, adaptive_attack_time)
            };
        }
        if self.auto_release {
            let adaptive_release_time = 2.0 * self.max_release / crest_ratio - adaptive_attack_time;
            release_coefficient = if adaptive_release_time <= 0.0 {
                1.0
            } else {
                fet_time_coefficient(self.sample_rate, adaptive_release_time)
            };
        }

        let log_input = input.max(0.000_001).ln();
        let difference = log_input - self.smoothed_threshold;
        let (ratio_multiplier, half_threshold_reduction, half_knee, knee_width) = if self.auto_knee
        {
            let half_threshold_reduction = self.smoothed_threshold * 0.5;
            let knee_width = -((self.adaptive_gain + half_threshold_reduction) * self.knee_multi);
            if knee_width <= 0.0 {
                (1.0, half_threshold_reduction, 0.0, 0.0)
            } else {
                (1.0, half_threshold_reduction, knee_width * 0.5, knee_width)
            }
        } else {
            let ratio_multiplier = -self.ratio;
            (
                ratio_multiplier,
                self.smoothed_threshold * ratio_multiplier * 0.5,
                self.knee * 0.5,
                self.knee,
            )
        };

        let mut gain_reduction = if difference >= half_knee {
            difference
        } else if difference <= -(knee_width * 0.5) {
            0.0
        } else {
            let shifted = difference + half_knee;
            shifted * shifted / (knee_width * 2.0)
        } * ratio_multiplier;

        let release_smoothed = self.release_smoothed_reduction
            + (gain_reduction - self.release_smoothed_reduction) * release_coefficient;
        if gain_reduction <= release_smoothed {
            gain_reduction = release_smoothed;
        }
        let reduction_difference = gain_reduction - self.attack_smoothed_reduction;
        self.release_smoothed_reduction = gain_reduction;
        let smoothed_reduction =
            self.attack_smoothed_reduction + reduction_difference * attack_coefficient;
        let negative_reduction = -smoothed_reduction;
        let adapt_target = negative_reduction - half_threshold_reduction - self.adaptive_gain;
        self.attack_smoothed_reduction = smoothed_reduction;
        self.adaptive_gain += adapt_target * self.adapt_coefficient;

        if self.auto_gain {
            if !self.no_clip {
                let makeup_gain = self.adaptive_gain + half_threshold_reduction;
                return (negative_reduction - makeup_gain).exp();
            }
            let mut output_level = log_input - smoothed_reduction;
            let mut makeup_gain = half_threshold_reduction + self.adaptive_gain;
            if output_level - makeup_gain > 0.001_151_270_4 {
                output_level = output_level - half_threshold_reduction + 0.001_151_270_4;
                makeup_gain = output_level + half_threshold_reduction;
                self.adaptive_gain = output_level;
            }
            return (negative_reduction - makeup_gain).exp();
        }
        (self.smoothed_gain - smoothed_reduction).exp()
    }

    fn advance_parameters(&mut self) {
        self.smoothed_threshold +=
            (self.threshold - self.smoothed_threshold) * self.smoothing_coefficient;
        self.smoothed_gain += self.smoothing_coefficient * (self.gain - self.smoothed_gain);
    }
}

fn fet_time_coefficient(sample_rate: f32, time: f32) -> f32 {
    1.0 - (-1.0 / (time * sample_rate)).exp()
}

struct SoftwareLimiter {
    write_index: usize,
    gate: f32,
    gain_envelope: f32,
    delay: [f32; Self::LOOKAHEAD],
    peak_tree: [f32; Self::LOOKAHEAD * 2],
}

impl SoftwareLimiter {
    const LOOKAHEAD: usize = 256;
    const RELEASE_COEFFICIENT: f32 = 0.000_283_420_1;

    fn new() -> Self {
        Self {
            write_index: 0,
            gate: 0.999_999,
            gain_envelope: 1.0,
            delay: [0.0; Self::LOOKAHEAD],
            peak_tree: [0.0; Self::LOOKAHEAD * 2],
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let sample = if sample.is_finite() { sample } else { 0.0 };
        let delayed = self.delay[self.write_index];
        let window_peak = self.peak_tree[1];
        let target_gain = if window_peak > self.gate {
            self.gate / window_peak
        } else {
            1.0
        };
        let released =
            self.gain_envelope + Self::RELEASE_COEFFICIENT * (1.0 - self.gain_envelope) + 1.0e-25;
        let gain = target_gain.min(released).min(1.0);
        self.gain_envelope = gain;

        let mut node = Self::LOOKAHEAD + self.write_index;
        self.peak_tree[node] = sample.abs();
        while node > 1 {
            let parent = node >> 1;
            let sibling = node ^ 1;
            self.peak_tree[parent] = self.peak_tree[node].max(self.peak_tree[sibling]);
            node = parent;
        }
        self.delay[self.write_index] = sample;
        self.write_index = (self.write_index + 1) & (Self::LOOKAHEAD - 1);
        delayed * gain
    }
}

#[derive(Clone, Copy, Default)]
struct MinimumPhaseBandState {
    input: [f64; 3],
    output: [f64; 3],
}

/// Ten parallel minimum-phase band-pass branches used by VPF Freestyle EQ.
///
/// This is intentionally separate from EchoMusic's manual RBJ equalizer: a flat VPF EQ still
/// passes through the complete filter bank, so skipping 0 dB bands would change its response.
struct MinimumPhaseEqualizer {
    coefficients: [[f64; 3]; EQ_BAND_COUNT],
    weights: [f64; EQ_BAND_COUNT],
    states: [[MinimumPhaseBandState; EQ_BAND_COUNT]; 2],
    current: usize,
    previous: usize,
    previous_two: usize,
}

impl MinimumPhaseEqualizer {
    fn new(sample_rate: u32, gains_db: [f32; EQ_BAND_COUNT]) -> Self {
        let sample_rate = sample_rate.max(8_000) as f64;
        let coefficients = std::array::from_fn(|index| {
            minimum_phase_band_coefficients(EQ_FREQUENCIES[index] as f64, sample_rate)
        });
        let weights =
            gains_db.map(|gain_db| (10.0f64.powf(gain_db as f64 / 20.0) * 0.636) as f32 as f64);
        Self {
            coefficients,
            weights,
            states: [[MinimumPhaseBandState::default(); EQ_BAND_COUNT]; 2],
            current: 2,
            previous: 1,
            previous_two: 0,
        }
    }

    fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let output = [left, right].map(|sample| sample as f64);
        let mut result = [0.0; 2];

        for channel in 0..2 {
            for band in 0..EQ_BAND_COUNT {
                let state = &mut self.states[channel][band];
                let [feedback_two, input_delta, feedback_one] = self.coefficients[band];
                state.input[self.current] = output[channel];
                let filtered = feedback_one * state.output[self.previous]
                    + input_delta * (output[channel] - state.input[self.previous_two])
                    - feedback_two * state.output[self.previous_two];
                state.output[self.current] = filtered;
                result[channel] += filtered * self.weights[band];
            }
        }

        self.current = (self.current + 1) % 3;
        self.previous = (self.previous + 1) % 3;
        self.previous_two = (self.previous_two + 1) % 3;
        (result[0] as f32, result[1] as f32)
    }
}

fn minimum_phase_band_coefficients(center_frequency: f64, sample_rate: f64) -> [f64; 3] {
    let lower_frequency = center_frequency / 2.0f64.sqrt();
    let center_radians = 2.0 * std::f64::consts::PI * center_frequency / sample_rate;
    let lower_radians = 2.0 * std::f64::consts::PI * lower_frequency / sample_rate;
    let center_cosine = center_radians.cos();
    let lower_cosine = lower_radians.cos();
    let lower_sine = lower_radians.sin();

    let a = center_cosine * lower_cosine;
    let b = center_cosine * center_cosine * 0.5;
    let c = lower_sine * lower_sine;
    let quadratic_a = b - a + 0.5 - c;
    let quadratic_b = c + b + lower_cosine * lower_cosine - a - 0.5;
    let quadratic_c = center_cosine * center_cosine * 0.125 - center_cosine * lower_cosine * 0.25
        + 0.125
        - c * 0.25;
    let discriminant_term =
        (quadratic_c - quadratic_b * quadratic_b / (quadratic_a * 4.0)) / quadratic_a;
    let midpoint = quadratic_b / (quadratic_a * 2.0);
    let root_distance = (-discriminant_term).max(0.0).sqrt();
    let root = (-midpoint - root_distance).min(root_distance - midpoint);

    [root * 2.0, 0.5 - root, (root + 0.5) * center_cosine * 2.0]
}

struct CombFilter {
    buffer: Vec<f32>,
    index: usize,
    feedback: f32,
    filter_store: f32,
    damping: f32,
    damping_inverse: f32,
}

impl CombFilter {
    fn new(size: usize, feedback: f32, damping: f32) -> Self {
        Self {
            buffer: vec![0.0; size],
            index: 0,
            feedback,
            filter_store: 0.0,
            damping,
            damping_inverse: 1.0 - damping,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let output = self.buffer[self.index];
        self.filter_store = output * self.damping_inverse + self.filter_store * self.damping;
        self.buffer[self.index] = sample + self.filter_store * self.feedback;
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

struct AllPassFilter {
    buffer: Vec<f32>,
    index: usize,
}

impl AllPassFilter {
    fn new(size: usize) -> Self {
        Self {
            buffer: vec![0.0; size],
            index: 0,
        }
    }

    fn process(&mut self, sample: f32) -> f32 {
        let output = self.buffer[self.index];
        self.buffer[self.index] = sample + output * 0.5;
        self.index = (self.index + 1) % self.buffer.len();
        output - sample
    }
}

struct StereoReverb {
    left_combs: Vec<CombFilter>,
    right_combs: Vec<CombFilter>,
    left_allpasses: Vec<AllPassFilter>,
    right_allpasses: Vec<AllPassFilter>,
    wet_primary: f32,
    wet_cross: f32,
    dry: f32,
}

impl StereoReverb {
    fn new(params: &ReverbParams) -> Self {
        const LEFT_COMB_SIZES: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        const RIGHT_COMB_SIZES: [usize; 8] = [1139, 1211, 1300, 1379, 1445, 1514, 1580, 1640];
        const LEFT_ALLPASS_SIZES: [usize; 4] = [556, 441, 341, 225];
        const RIGHT_ALLPASS_SIZES: [usize; 4] = [579, 464, 364, 248];

        let feedback = params.room_size * 0.28 + 0.7;
        let damping = params.damping * 0.4;
        let wet = params.wet * 3.0;
        Self {
            left_combs: LEFT_COMB_SIZES
                .map(|size| CombFilter::new(size, feedback, damping))
                .into(),
            right_combs: RIGHT_COMB_SIZES
                .map(|size| CombFilter::new(size, feedback, damping))
                .into(),
            left_allpasses: LEFT_ALLPASS_SIZES.map(AllPassFilter::new).into(),
            right_allpasses: RIGHT_ALLPASS_SIZES.map(AllPassFilter::new).into(),
            wet_primary: wet * (params.width * 0.5 + 0.5),
            wet_cross: wet * (1.0 - params.width) * 0.5,
            dry: params.dry * 2.0,
        }
    }

    fn process(&mut self, left: f32, right: f32) -> (f32, f32) {
        let input = (left + right) * 0.015;
        let mut wet_left = self
            .left_combs
            .iter_mut()
            .map(|comb| comb.process(input))
            .sum();
        let mut wet_right = self
            .right_combs
            .iter_mut()
            .map(|comb| comb.process(input))
            .sum();
        for allpass in &mut self.left_allpasses {
            wet_left = allpass.process(wet_left);
        }
        for allpass in &mut self.right_allpasses {
            wet_right = allpass.process(wet_right);
        }
        (
            wet_left * self.wet_primary + wet_right * self.wet_cross + left * self.dry,
            wet_right * self.wet_primary + wet_left * self.wet_cross + right * self.dry,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const REAL_SAMPLE_GOLDEN_FINGERPRINTS: [(&str, u64); 22] = [
        ("7277.vpf", 0x91c8_ee96_e79b_9d05),
        ("7617.vpf", 0x10e6_4ca8_197b_7a35),
        ("7675.vpf", 0xd86d_ab73_d766_fe2f),
        ("7803.vpf", 0x0381_bab4_7ff1_feaf),
        ("7823.vpf", 0xde20_e55f_7ca5_a66b),
        ("7829.vpf", 0xbb86_c668_8e3e_0e6a),
        ("7841.vpf", 0xcac7_117f_e25e_28c7),
        ("7983.vpf", 0x7434_1f87_2181_5a42),
        ("8007.vpf", 0x0a80_80fe_64be_8966),
        ("8025.vpf", 0x3b1f_f999_871a_9d31),
        ("8029.vpf", 0xf243_bed4_f007_3813),
        ("8033.vpf", 0x2790_5da3_1338_0346),
        ("8035.vpf", 0x9cdf_aee7_6016_b70c),
        ("8039.vpf", 0x45e4_5057_550a_5313),
        ("8041.vpf", 0x119f_ed69_dd0d_7d03),
        ("8045.vpf", 0xec05_90fe_f269_9fc9),
        ("8053.vpf", 0x77bb_bed8_87ef_2e6a),
        ("8055.vpf", 0x7fff_7f0c_d44e_2472),
        ("8059.vpf", 0x34b2_9662_ae82_9fb9),
        ("8061.vpf", 0x7a9f_6ecc_6ddd_7196),
        ("8071.vpf", 0x80fa_5a58_1b48_a98b),
        ("8075.vpf", 0xff5b_e905_7cff_c731),
    ];

    fn fnv1a(bytes: &[u8]) -> u64 {
        bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
    }

    fn put_i32(data: &mut [u8], offset: usize, value: i32) {
        data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_f32(data: &mut [u8], offset: usize, value: f32) {
        put_i32(data, offset, value.to_bits() as i32);
    }

    fn synthetic_vpf() -> Vec<u8> {
        let mut data = vec![0; VPF_MAGIC.len() + 4 + SECTION_SIZES[FREESTYLE_SECTION]];
        data[..VPF_MAGIC.len()].copy_from_slice(&VPF_MAGIC);
        data[VPF_MAGIC.len() + FREESTYLE_SECTION] = 1;
        let section = &mut data[VPF_MAGIC.len() + 4..];
        put_i32(section, 0x214, 1);
        put_i32(section, 0x21c, 80);
        put_f32(section, 0x220, 4.0);
        put_i32(section, 0x26c, 1);
        for offset in (0x270..=0x2b0).step_by(8) {
            put_f32(section, offset, 1.0);
        }
        put_f32(section, 0x2d4, 1.0);
        put_f32(section, 0x2e0, 10.0);
        put_f32(section, 0x2e4, 100.0);
        put_f32(section, 0x318, 1.0);
        data
    }

    #[test]
    fn parses_supported_section_and_allows_zero_db_eq() {
        let params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        assert!(params.bass.enabled);
        assert_eq!(params.bass.frequency, 80.0);
        assert!(params.equalizer.enabled);
        assert_eq!(params.equalizer.gains_db, [0.0; 10]);
    }

    #[test]
    fn real_sample_parameter_golden_fingerprints_match_when_corpus_is_available() {
        let corpus = std::env::var_os("ECHOMUSIC_VPF_SAMPLE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp/opencode/vpf_samples/cross_validation"));
        let require_corpus = std::env::var_os("ECHOMUSIC_VPF_REQUIRE_CORPUS")
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        if !corpus.is_dir() {
            assert!(
                !require_corpus,
                "required VPF sample corpus is missing: {}",
                corpus.display()
            );
            return;
        }

        let mut mismatches = Vec::new();
        for (file_name, expected_fingerprint) in REAL_SAMPLE_GOLDEN_FINGERPRINTS {
            let data =
                fs::read(corpus.join(file_name)).expect("real VPF sample should be readable");
            let params = parse_vpf(&data).expect("real VPF sample should parse");
            let snapshot = serde_json::to_vec(&params).expect("VPF snapshot should serialize");
            let actual_fingerprint = fnv1a(&snapshot);
            if actual_fingerprint != expected_fingerprint {
                mismatches.push(format!(
                    "{file_name}: expected {expected_fingerprint:#018x}, got {actual_fingerprint:#018x}"
                ));
            }
        }
        assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
    }

    #[test]
    fn representative_real_vpf_pcm_matches_when_corpus_is_available() {
        const SELECTED: [usize; 12] = [
            0, 255, 256, 511, 767, 768, 1023, 1279, 1535, 1536, 1792, 2047,
        ];
        const CASES: [(&str, [[f32; 2]; 12]); 4] = [
            (
                "8041.vpf",
                [
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.999998987, -0.999998987],
                    [-0.220389843, -0.179690123],
                    [-0.232212111, 0.187625021],
                    [-0.231679991, 0.201830566],
                    [-0.450840414, 0.579625189],
                    [-0.111950077, 0.327932358],
                    [0.073694386, -0.178973883],
                    [0.054166224, -0.188907564],
                    [0.440787792, -0.571070492],
                    [0.411595881, -0.374553710],
                ],
            ),
            (
                "8059.vpf",
                [
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.192642704, -0.101829052],
                    [-0.215173140, -0.138314143],
                    [-0.166198000, 0.055212725],
                    [-0.162506968, 0.058341555],
                    [-0.177629158, 0.172230735],
                    [-0.080430508, -0.055617128],
                    [-0.010857846, -0.009035531],
                    [-0.017029447, -0.007197091],
                    [0.093053810, -0.039442703],
                    [0.182361901, -0.065917104],
                ],
            ),
            (
                "8061.vpf",
                [
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.588673174, -0.517092407],
                    [0.140529424, -0.479137391],
                    [0.204651743, -0.170495048],
                    [0.263076097, -0.189611062],
                    [0.220530644, 0.221644536],
                    [-0.237385303, 0.262817889],
                    [0.059777547, -0.115812957],
                    [0.051049173, -0.157054737],
                    [-0.348934323, -0.448485821],
                    [-0.245927230, -0.305782735],
                ],
            ),
            (
                "8075.vpf",
                [
                    [0.0, 0.0],
                    [0.0, 0.0],
                    [0.639893711, -0.551862895],
                    [0.116651721, -0.549077690],
                    [0.273148656, -0.150442317],
                    [0.284442991, -0.137584224],
                    [0.138398439, 0.056078549],
                    [0.197744995, -0.229053214],
                    [0.007288610, -0.224112034],
                    [0.035977274, -0.231461480],
                    [-0.213901654, -0.579743564],
                    [-0.010367581, -0.041763972],
                ],
            ),
        ];

        let corpus = std::env::var_os("ECHOMUSIC_VPF_SAMPLE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp/opencode/vpf_samples/cross_validation"));
        let require_corpus = std::env::var_os("ECHOMUSIC_VPF_REQUIRE_CORPUS")
            .is_some_and(|value| value == "1" || value.eq_ignore_ascii_case("true"));
        if !corpus.is_dir() {
            assert!(
                !require_corpus,
                "required VPF sample corpus is missing: {}",
                corpus.display()
            );
            return;
        }

        for (file_name, expected) in CASES {
            let path = corpus.join(file_name);
            let vpf = load_vpf(path.to_str().expect("sample path should be UTF-8"))
                .expect("real VPF sample should load");
            let mut samples = Vec::with_capacity(4096);
            for frame in 0..2048 {
                let time = frame as f32;
                samples.push(if frame == 0 {
                    0.8
                } else {
                    0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
                });
                samples.push(if frame == 0 {
                    -0.35
                } else {
                    -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
                });
            }
            let mut processor = VpfProcessor::new(48_000, &vpf);
            let vhe_latency = if vpf.params.headphone.enabled {
                processor.headphone.latency_frames()
            } else {
                0
            };
            samples.resize(samples.len() + vhe_latency * 2, 0.0);
            for block in samples.chunks_mut(512) {
                processor.process_interleaved(block);
            }

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[(frame + vhe_latency) * 2 + channel]
                            - expected[position][channel])
                            .abs()
                            <= 3.0e-5,
                        "{file_name}, frame {frame}, channel {channel}: expected {}, got {}",
                        expected[position][channel],
                        samples[(frame + vhe_latency) * 2 + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn parses_all_active_fields() {
        let mut data = synthetic_vpf();
        let section = &mut data[VPF_MAGIC.len() + 4..];
        put_i32(section, 0x218, 2);
        put_i32(section, 0x21c, 95);
        put_f32(section, 0x220, 3.5);
        put_i32(section, 0x224, 1);
        put_i32(section, 0x228, 1);
        put_f32(section, 0x22c, 2.5);
        put_i32(section, 0x230, 1);
        put_i32(section, 0x234, 1);
        put_f32(section, 0x238, 0.4);
        put_f32(section, 0x23c, 0.8);
        put_i32(section, 0x240, 3);
        put_i32(section, 0x244, 1);
        put_f32(section, 0x248, 0.7);
        put_f32(section, 0x24c, 0.6);
        put_f32(section, 0x250, 0.5);
        put_f32(section, 0x264, 0.4);
        put_f32(section, 0x268, 0.9);
        put_i32(section, 0x2b8, 1);
        put_i32(section, 0x2bc, 1);
        put_i32(section, 0x2c0, 1);
        put_i32(section, 0x2c4, 1);
        put_i32(section, 0x2c8, 1);
        put_i32(section, 0x2cc, 1);
        put_f32(section, 0x2d0, 0.3);
        put_f32(section, 0x2d4, 0.5);
        put_f32(section, 0x2d8, 0.6);
        put_f32(section, 0x2dc, 0.1);
        put_f32(section, 0x2e0, 0.514679);
        put_f32(section, 0x2e4, 0.384311);
        put_f32(section, 0x2e8, 0.5);
        put_f32(section, 0x2ec, 0.87945);
        put_f32(section, 0x2f0, 0.884311);
        put_f32(section, 0x2f4, 0.615689);
        put_f32(section, 0x2f8, 0.660964);
        put_i32(section, 0x2fc, 1);
        put_f32(section, 0x300, 0.5);
        put_f32(section, 0x304, 0.8);
        put_f32(section, 0x308, 1.5);
        put_i32(section, 0x30c, 1);
        put_i32(section, 0x310, 0x003c_02bc);
        put_i32(section, 0x314, 1);
        put_f32(section, 0x318, 2.25);

        let params = parse_vpf(&data).expect("VPF should parse");
        assert_eq!(
            params.bass,
            BassParams {
                enabled: true,
                mode: 2,
                frequency: 95.0,
                gain: 3.5
            }
        );
        assert_eq!(
            params.clarity,
            ClarityParams {
                enabled: true,
                mode: 1,
                gain: 2.5
            }
        );
        assert_eq!(
            params.field,
            FieldParams {
                enabled: true,
                widening: 0.4,
                mid_image: 0.8
            }
        );
        assert_eq!(
            params.headphone,
            HeadphoneParams {
                enabled: true,
                level: 3
            }
        );
        assert_eq!(
            params.reverb,
            ReverbParams {
                enabled: true,
                room_size: 0.7,
                width: 0.6,
                damping: 0.5,
                wet: 0.4,
                dry: 0.9
            }
        );
        assert_eq!(
            params.compressor,
            CompressorParams {
                enabled: true,
                threshold: 0.3,
                ratio: 0.5,
                knee: 0.6,
                auto_knee: true,
                gain: 0.1,
                auto_gain: true,
                attack: 0.514679,
                auto_attack: true,
                release: 0.384311,
                auto_release: true,
                knee_multi: 0.5,
                max_attack: 0.87945,
                max_release: 0.884311,
                crest: 0.615689,
                adapt: 0.660964,
                no_clip: true
            }
        );
        assert_eq!(
            params.playback,
            PlaybackParams {
                enabled: true,
                ratio: 0.5,
                volume: 0.8,
                max_scaler: 1.5
            }
        );
        assert_eq!(
            params.crossfeed,
            CrossfeedParams {
                enabled: true,
                preset: 1
            }
        );
        assert!(params.tube_enabled);
        assert_eq!(params.output_volume, 2.25);
    }

    #[test]
    fn non_boolean_playback_slot_only_enables_playback() {
        let mut data = synthetic_vpf();
        let section = &mut data[VPF_MAGIC.len() + 4..];
        put_i32(section, 0x2fc, 25);

        let params = parse_vpf(&data).expect("VPF should parse");
        assert!(params.playback.enabled);
    }

    #[test]
    fn rejects_non_finite_fields() {
        let mut data = synthetic_vpf();
        let section = &mut data[VPF_MAGIC.len() + 4..];
        put_f32(section, 0x318, f32::NAN);
        assert!(parse_vpf(&data).is_err());
    }

    #[test]
    fn rejects_invalid_section_flags() {
        let mut data = synthetic_vpf();
        data[VPF_MAGIC.len() + FREESTYLE_SECTION] = 2;
        assert!(parse_vpf(&data).is_err());
    }

    #[test]
    fn rejects_truncated_and_trailing_data() {
        let mut truncated = synthetic_vpf();
        truncated.pop();
        assert!(parse_vpf(&truncated).is_err());

        let mut trailing = synthetic_vpf();
        trailing.push(0);
        assert!(parse_vpf(&trailing).is_err());
    }

    #[test]
    fn load_rejects_oversized_file_from_metadata() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let file_path = std::env::temp_dir().join(format!(
            "echomusic-oversized-vpf-{}-{unique}.vpf",
            std::process::id()
        ));
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&file_path)
            .expect("temporary VPF should be created");
        file.set_len(MAX_VPF_BYTES as u64 + 1)
            .expect("temporary VPF should be resized");

        let result = load_vpf(file_path.to_str().expect("temporary path should be UTF-8"));
        fs::remove_file(&file_path).expect("temporary VPF should be removed");

        assert_eq!(result.unwrap_err(), "VPF exceeds size limit");
    }

    #[test]
    fn preserves_linear_output_volume() {
        let mut data = synthetic_vpf();
        let section = &mut data[VPF_MAGIC.len() + 4..];
        put_f32(section, 0x318, 2.25);
        let params = parse_vpf(&data).expect("VPF should parse");
        assert_eq!(params.output_volume, 2.25);
    }

    #[test]
    fn processor_changes_enabled_bass_output() {
        let params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        let vpf = PreparedVpf {
            file_path: "test.vpf".to_string(),
            params,
        };
        let mut processor = VpfProcessor::new(48_000, &vpf);
        let mut samples = vec![0.25; 512];
        processor.process_interleaved(&mut samples);
        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples.iter().any(|sample| (*sample - 0.25).abs() > 0.0001));
    }

    #[test]
    fn malformed_stereo_buffer_bypasses_complete_vpf_chain() {
        let params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        let vpf = PreparedVpf {
            file_path: "malformed-buffer.vpf".to_string(),
            params,
        };
        let mut processor = VpfProcessor::new(48_000, &vpf);
        let mut samples = vec![0.25, -0.5, 0.75];
        let original = samples.clone();

        processor.process_interleaved(&mut samples);

        assert_eq!(samples, original);
    }

    #[test]
    fn zero_db_equalizer_keeps_reference_filter_bank() {
        let params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        let vpf = PreparedVpf {
            file_path: "test.vpf".to_string(),
            params,
        };
        let processor = VpfProcessor::new(48_000, &vpf);
        assert!(processor.eq.is_some());
        assert_eq!(processor.latency_frames(), SoftwareLimiter::LOOKAHEAD);
    }

    #[test]
    fn pure_bass_latency_includes_phase_filter() {
        let mut params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        params.bass.mode = 1;
        let vpf = PreparedVpf {
            file_path: "pure-bass.vpf".to_string(),
            params,
        };
        let processor = VpfProcessor::new(48_000, &vpf);
        assert_eq!(
            processor.latency_frames(),
            SoftwareLimiter::LOOKAHEAD + BassProcessor::PURE_LATENCY
        );
    }

    #[test]
    fn enabled_vhe_latency_is_included() {
        let mut params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        params.headphone.enabled = true;
        let vpf = PreparedVpf {
            file_path: "vhe-latency.vpf".to_string(),
            params,
        };
        let processor = VpfProcessor::new(48_000, &vpf);
        assert_eq!(
            processor.latency_frames(),
            SoftwareLimiter::LOOKAHEAD + processor.headphone.latency_frames()
        );
    }

    #[test]
    fn minimum_phase_equalizer_matches_pcm_oracle() {
        const GAINS: [f32; 10] = [6.0, -3.0, 0.0, 2.5, -1.0, 4.0, -5.0, 1.0, 3.0, -2.0];
        const EXPECTED: [[f32; 2]; 64] = [
            [0.636709571, -0.318354785],
            [0.329607457, -0.179660290],
            [-0.061278261, -0.109508514],
            [-0.141938031, -0.062883437],
            [-0.311735094, -0.014161852],
            [0.318856955, -0.021504192],
            [0.005872128, -0.000083005],
            [-0.084035441, 0.041330826],
            [0.351679146, 0.079174064],
            [-0.012398909, 0.111155920],
            [0.008580514, 0.136083990],
            [-0.153363392, -0.353884041],
            [-0.300905734, -0.141653389],
            [0.256836742, -0.155713528],
            [-0.099766776, -0.056394424],
            [-0.170893848, 0.002721017],
            [0.271614224, -0.002150151],
            [-0.097639516, 0.027103951],
            [-0.087461479, 0.070348032],
            [0.384983867, 0.112739794],
            [0.013106228, 0.147635192],
            [0.002423297, 0.169851288],
            [-0.187638253, -0.326575756],
            [-0.333638072, -0.122264400],
            [0.245799944, -0.143181548],
            [-0.085767306, -0.048203569],
            [-0.138259232, 0.009019013],
            [0.313942492, 0.004038682],
            [-0.051825605, 0.034198429],
            [-0.041356407, 0.078702070],
            [0.429528832, 0.122217230],
            [0.054813117, 0.157747775],
            [0.040702835, 0.179912224],
            [-0.152369499, -0.317273468],
            [-0.300053209, -0.114290088],
            [0.279378384, -0.136870801],
            [-0.050790936, -0.043640301],
            [-0.101116978, 0.011959440],
            [0.353342116, 0.005618328],
            [-0.010588378, 0.034746047],
            [0.001005334, 0.078558199],
            [-0.170884058, 0.121699244],
            [-0.319525838, 0.157132834],
            [0.243758321, 0.179433718],
            [-0.105969556, -0.317420930],
            [-0.171917990, -0.113942102],
            [0.273270071, -0.135885432],
            [-0.095015593, -0.041893687],
            [-0.084750436, 0.014573362],
            [0.387150258, 0.009184715],
            [0.014118739, 0.039324477],
            [0.001807486, 0.084178396],
            [-0.190037414, 0.128358632],
            [-0.337621838, 0.164796814],
            [0.240637332, 0.188038468],
            [-0.091692612, -0.307963490],
            [-0.144652128, -0.103738077],
            [0.307219893, -0.125052124],
            [-0.058869422, -0.030553212],
            [-0.048794877, 0.026299570],
            [0.421582311, 0.021180186],
            [0.046237025, 0.051480718],
            [0.031391520, 0.096396811],
            [-0.162488550, 0.140551478],
        ];

        let mut equalizer = MinimumPhaseEqualizer::new(48_000, GAINS);
        for (frame_index, expected) in EXPECTED.iter().enumerate() {
            let left = if frame_index == 0 {
                1.0
            } else {
                ((frame_index * 37 % 101) as i32 - 50) as f32 / 100.0
            };
            let right = if frame_index == 0 {
                -0.5
            } else {
                ((frame_index * 53 % 97) as i32 - 48) as f32 / 120.0
            };
            let actual = equalizer.process(left, right);
            assert!(
                (actual.0 - expected[0]).abs() <= 1.0e-6,
                "left frame {frame_index}: expected {}, got {}",
                expected[0],
                actual.0
            );
            assert!(
                (actual.1 - expected[1]).abs() <= 1.0e-6,
                "right frame {frame_index}: expected {}, got {}",
                expected[1],
                actual.1
            );
        }
    }

    #[test]
    fn minimum_phase_equalizer_center_frequency_rms_matches_pcm_oracle() {
        const GAINS: [f32; 10] = [6.0, -3.0, 0.0, 2.5, -1.0, 4.0, -5.0, 1.0, 3.0, -2.0];
        const EXPECTED_RMS: [f64; 10] = [
            0.240222886,
            0.150068066,
            0.166990833,
            0.201549051,
            0.167963469,
            0.221246383,
            0.131820535,
            0.178346092,
            0.205264968,
            0.126130237,
        ];

        for (frequency, expected_rms) in EQ_FREQUENCIES.into_iter().zip(EXPECTED_RMS) {
            let mut equalizer = MinimumPhaseEqualizer::new(48_000, GAINS);
            let mut sum = 0.0;
            for frame in 0..4096 {
                let phase = 2.0 * std::f32::consts::PI * frequency * frame as f32 / 48_000.0;
                let output = equalizer.process(phase.sin() * 0.25, phase.cos() * 0.25);
                if frame >= 2048 {
                    sum += f64::from(output.0) * f64::from(output.0);
                }
            }
            let actual_rms = (sum / 2048.0).sqrt();
            assert!(
                (actual_rms - expected_rms).abs() <= 2.0e-6,
                "{frequency} Hz: expected {expected_rms}, got {actual_rms}"
            );
        }
    }

    #[test]
    fn stereo_reverb_matches_pcm_oracle() {
        const EXPECTED: [(usize, [f32; 2]); 42] = [
            (0, [1.10000002, -0.550000012]),
            (1, [-0.142999992, 0.045833334]),
            (224, [-0.483999997, -0.091666669]),
            (225, [-0.077000000, 0.394166648]),
            (555, [-0.198000014, -0.220000014]),
            (556, [0.209000006, 0.265833318]),
            (1115, [-0.033000000, -0.238333344]),
            (1116, [0.381607264, 0.249342754]),
            (1138, [0.427473426, 0.262798935]),
            (1139, [-0.262334764, -0.129935756]),
            (1187, [0.380754918, 0.061324265]),
            (1188, [-0.312595725, -0.327804953]),
            (1210, [-0.269002944, -0.328266382]),
            (1211, [0.164550304, 0.171207711]),
            (1276, [-0.061915826, -0.262949497]),
            (1277, [0.373691857, 0.215444162]),
            (1299, [0.407089353, 0.228075996]),
            (1300, [-0.292001218, -0.143658280]),
            (1355, [-0.124267340, -0.135019824]),
            (1356, [0.305012465, 0.365042239]),
            (1378, [0.338692516, 0.378840506]),
            (1379, [-0.351066500, -0.002162338]),
            (1421, [0.084071279, -0.064339444]),
            (1422, [0.470319390, 0.425298780]),
            (1444, [0.519366086, 0.442819417]),
            (1445, [-0.153151706, 0.025486374]),
            (1490, [0.378748506, -0.325260520]),
            (1491, [-0.323642462, 0.161105812]),
            (1513, [-0.257077515, 0.140286684]),
            (1514, [0.182153448, -0.190099105]),
            (1556, [-0.547163963, -0.257348031]),
            (1557, [-0.104208931, 0.173630252]),
            (1579, [-0.047388814, 0.195945978]),
            (1580, [0.362643778, -0.153137192]),
            (1616, [-0.585258007, 0.424463958]),
            (1617, [-0.131163552, -0.005032107]),
            (1639, [-0.092200406, -0.001005675]),
            (1640, [0.380744934, -0.340709120]),
            (1800, [-0.111024231, -0.009308986]),
            (2047, [0.438355118, -0.054626402]),
            (3000, [-0.542324126, -0.259744316]),
            (4095, [-0.291983396, 0.077698976]),
        ];
        let params = ReverbParams {
            enabled: true,
            room_size: 0.73,
            width: 0.61,
            damping: 0.37,
            wet: 0.42,
            dry: 0.55,
        };
        let mut reverb = StereoReverb::new(&params);
        let mut output = Vec::with_capacity(4096);
        for frame_index in 0..4096 {
            let left = if frame_index == 0 {
                1.0
            } else {
                ((frame_index * 37 % 101) as i32 - 50) as f32 / 100.0
            };
            let right = if frame_index == 0 {
                -0.5
            } else {
                ((frame_index * 53 % 97) as i32 - 48) as f32 / 120.0
            };
            output.push(reverb.process(left, right));
        }

        for (frame_index, expected) in EXPECTED {
            let actual = output[frame_index];
            assert!(
                (actual.0 - expected[0]).abs() <= 1.0e-6,
                "left frame {frame_index}: expected {}, got {}",
                expected[0],
                actual.0
            );
            assert!(
                (actual.1 - expected[1]).abs() <= 1.0e-6,
                "right frame {frame_index}: expected {}, got {}",
                expected[1],
                actual.1
            );
        }
    }

    #[test]
    fn software_limiter_matches_pcm_oracle() {
        const EXPECTED: [(usize, f32); 18] = [
            (0, 0.0),
            (1, 0.0),
            (2, 0.0),
            (254, 0.0),
            (255, 0.0),
            (256, 0.999998987),
            (257, -0.259999722),
            (258, 0.479999512),
            (351, 0.619999349),
            (352, -0.659999371),
            (353, 0.049230717),
            (511, -0.098461434),
            (512, 0.356922686),
            (608, -0.999998987),
            (609, -0.221679524),
            (700, 0.208328202),
            (900, 0.623821914),
            (1023, 0.753668010),
        ];
        let mut limiter = SoftwareLimiter::new();
        let mut output = Vec::with_capacity(1024);
        for index in 0..1024 {
            let mut sample = ((index * 37 % 101) as i32 - 50) as f32 / 25.0;
            if index == 0 {
                sample = 2.0;
            } else if index == 352 {
                sample = -3.25;
            }
            output.push(limiter.process(sample));
        }

        for (index, expected) in EXPECTED {
            assert!(
                (output[index] - expected).abs() <= 1.0e-6,
                "sample {index}: expected {expected}, got {}",
                output[index]
            );
        }
    }

    #[test]
    fn colorful_music_matches_pcm_oracle() {
        let actual = colorful_music(0.35, -0.2, 0.6, 1.3);
        assert!((actual.0 - 0.41346154).abs() <= 1.0e-7);
        assert!((actual.1 + 0.26346153).abs() <= 1.0e-7);
    }

    #[test]
    fn fet_compressor_matches_pcm_oracle() {
        const EXPECTED: [(usize, [f32; 2]); 20] = [
            (0, [-1.0, -0.800000012]),
            (1, [-0.260112256, 0.083369315]),
            (2, [0.480414450, -0.650561213]),
            (3, [-0.801036179, 0.233635545]),
            (7, [0.140423104, 0.534945190]),
            (15, [0.0, -0.486463517]),
            (31, [-0.279247463, 0.714740515]),
            (63, [-0.834367514, -0.115884379]),
            (127, [0.059029795, -0.163971663]),
            (128, [0.786983907, 0.705006421]),
            (255, [-0.152858183, -0.254763663]),
            (256, [0.554018259, 0.589042425]),
            (351, [0.168653786, 0.437250525]),
            (352, [0.861818612, -0.249802500]),
            (353, [-0.337161869, 0.577545822]),
            (511, [-0.545319378, -0.424137294]),
            (700, [-0.104987644, -0.029163238]),
            (900, [0.353360027, 0.350555599]),
            (1022, [-0.164403319, -0.109602220]),
            (1023, [0.443793803, 0.616380274]),
        ];
        let params = CompressorParams {
            enabled: true,
            threshold: 0.3,
            ratio: 0.5,
            knee: 0.6,
            auto_knee: true,
            gain: 0.1,
            auto_gain: true,
            attack: 0.514679,
            auto_attack: true,
            release: 0.384311,
            auto_release: true,
            knee_multi: 0.5,
            max_attack: 0.87945,
            max_release: 0.884311,
            crest: 0.615689,
            adapt: 0.660964,
            no_clip: true,
        };
        let mut compressor = FetCompressor::new(48_000, &params);
        let mut output = Vec::with_capacity(1024);
        for frame in 0..1024 {
            let mut left = ((frame * 37 % 101) as i32 - 50) as f32 / 50.0;
            let mut right = ((frame * 53 % 97) as i32 - 48) as f32 / 60.0;
            let gain = compressor.process_sidechain(left.abs().max(right.abs()));
            left *= gain;
            right *= gain;
            compressor.advance_parameters();
            output.push((left, right));
        }

        for (frame, expected) in EXPECTED {
            let actual = output[frame];
            assert!(
                (actual.0 - expected[0]).abs() <= 2.0e-6,
                "left frame {frame}: expected {}, got {}",
                expected[0],
                actual.0
            );
            assert!(
                (actual.1 - expected[1]).abs() <= 2.0e-6,
                "right frame {frame}: expected {}, got {}",
                expected[1],
                actual.1
            );
        }
    }

    #[test]
    fn playback_gain_matches_block_pcm_oracle() {
        const EXPECTED: [(usize, [f32; 2]); 18] = [
            (0, [-1.0, -0.800000012]),
            (1, [-0.259956658, 0.083319441]),
            (2, [0.479839951, -0.649783254]),
            (127, [0.058729637, -0.163137883]),
            (255, [-0.153198063, -0.255330116]),
            (256, [0.555246234, 0.590348065]),
            (257, [-0.670033038, -0.111672170]),
            (511, [-0.554329813, -0.431145370]),
            (512, [0.129325256, 0.384896576]),
            (513, [0.812810779, -0.292488724]),
            (700, [-0.108521231, -0.030144788]),
            (767, [0.879478335, -0.598284602]),
            (768, [-0.269197106, 0.194420114]),
            (769, [0.394786626, -0.463575214]),
            (900, [0.372371882, 0.369416565]),
            (1021, [-0.824163437, 0.526061773]),
            (1022, [-0.175337672, -0.116891786]),
            (1023, [0.473367870, 0.657455325]),
        ];
        let params = PlaybackParams {
            enabled: true,
            ratio: 0.5,
            volume: 0.8,
            max_scaler: 1.5,
        };
        let mut gain = PlaybackGain::new(48_000, &params);
        let mut samples = Vec::with_capacity(2048);
        for frame in 0..1024 {
            samples.push(((frame * 37 % 101) as i32 - 50) as f32 / 50.0);
            samples.push(((frame * 53 % 97) as i32 - 48) as f32 / 60.0);
        }
        for block in samples.chunks_exact_mut(512) {
            gain.process(block);
        }
        for (frame, expected) in EXPECTED {
            assert!(
                (samples[frame * 2] - expected[0]).abs() <= 2.0e-6,
                "left frame {frame}: expected {}, got {}",
                expected[0],
                samples[frame * 2]
            );
            assert!(
                (samples[frame * 2 + 1] - expected[1]).abs() <= 2.0e-6,
                "right frame {frame}: expected {}, got {}",
                expected[1],
                samples[frame * 2 + 1]
            );
        }
    }

    #[test]
    fn cure_matches_pcm_oracle() {
        const SELECTED: [usize; 21] = [
            0, 1, 2, 3, 4, 5, 7, 11, 15, 23, 31, 47, 63, 95, 127, 191, 255, 383, 511, 767, 1023,
        ];
        const EXPECTED: [[[f32; 2]; 21]; 2] = [
            [
                [0.227586001, -0.092887774],
                [0.414206684, -0.206994206],
                [0.111187451, -0.146833599],
                [-0.023888895, -0.094279855],
                [0.096050926, -0.119704381],
                [0.063854590, -0.102878973],
                [0.093681954, -0.092244573],
                [0.121482171, -0.059090074],
                [0.145594433, -0.022727689],
                [0.167286500, 0.053491704],
                [0.146870241, 0.120746613],
                [0.021750128, 0.181163371],
                [-0.069957033, 0.133679166],
                [0.115479469, -0.025285730],
                [-0.001250519, -0.045193147],
                [0.147665933, 0.075879589],
                [-0.214866146, -0.186231896],
                [0.132748902, 0.086219773],
                [-0.128722280, 0.012037980],
                [-0.127018556, 0.114346541],
                [0.018632205, 0.137302235],
            ],
            [
                [0.215958193, -0.086739928],
                [0.391141295, -0.191979855],
                [0.099997938, -0.133243293],
                [-0.029462963, -0.083079889],
                [0.084254652, -0.106494449],
                [0.052776396, -0.089856043],
                [0.079949297, -0.078424595],
                [0.104431286, -0.044245936],
                [0.126216322, -0.007177927],
                [0.147111133, 0.068731315],
                [0.131158352, 0.132714882],
                [0.025118696, 0.179058656],
                [-0.050590869, 0.117841333],
                [0.114883490, -0.026039114],
                [-0.013404049, -0.029432548],
                [0.149448514, 0.069472291],
                [-0.212637097, -0.190335900],
                [0.117328241, 0.096296661],
                [-0.121688977, 0.004962035],
                [-0.105406389, 0.095479533],
                [0.028430447, 0.133763999],
            ],
        ];

        for (preset_index, expected) in EXPECTED.iter().enumerate() {
            let mut samples = Vec::with_capacity(2048);
            for frame in 0..1024 {
                let time = frame as f32;
                samples.push(if frame == 0 {
                    0.8
                } else {
                    0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
                });
                samples.push(if frame == 0 {
                    -0.35
                } else {
                    -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
                });
            }
            let mut cure = CureProcessor::new(48_000, preset_index as u8 + 1);
            cure.process(&mut samples);

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[frame * 2 + channel] - expected[position][channel]).abs()
                            <= 2.0e-6,
                        "preset {}, frame {frame}, channel {channel}: expected {}, got {}",
                        preset_index + 1,
                        expected[position][channel],
                        samples[frame * 2 + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn clarity_modes_match_pcm_oracle() {
        const SELECTED: [usize; 18] = [
            0, 1, 2, 3, 7, 15, 31, 63, 119, 120, 127, 239, 240, 255, 383, 511, 767, 1023,
        ];
        const EXPECTED: [[[f32; 2]; 18]; 3] = [
            [
                [1.651739359, -0.722635984],
                [-0.614485383, -0.042974904],
                [0.067111433, -0.173271626],
                [0.136842072, -0.182199270],
                [0.195964098, -0.165535539],
                [0.279330432, -0.110016540],
                [0.239470258, 0.053840980],
                [-0.181512937, 0.231352344],
                [0.181310013, -0.152140081],
                [0.169678301, -0.151654005],
                [0.067817926, -0.134121671],
                [-0.295425296, -0.237692535],
                [-0.298604816, -0.235944226],
                [-0.211485788, -0.151050910],
                [0.214365497, 0.030836154],
                [-0.160076559, 0.066087656],
                [-0.268668771, 0.233968765],
                [-0.050727945, 0.151281267],
            ],
            [
                [1.552744985, -0.679325938],
                [-0.677487314, 0.003276455],
                [0.031993866, -0.130436897],
                [0.249306887, -0.202491879],
                [0.186010897, -0.166523725],
                [0.274452448, -0.113943845],
                [0.243881807, 0.048140410],
                [-0.178220496, 0.231753483],
                [0.185756013, -0.151516706],
                [0.174652338, -0.151302785],
                [0.075718299, -0.135638088],
                [-0.291890860, -0.237680197],
                [-0.295639068, -0.236220628],
                [-0.217159316, -0.155117810],
                [0.217051148, 0.025384361],
                [-0.160260156, 0.061519898],
                [-0.263842583, 0.232738197],
                [-0.042155053, 0.154370129],
            ],
            [
                [2.294502020, -1.003844619],
                [-0.756887794, -0.102013268],
                [-0.525610328, 0.011783846],
                [-0.354861736, 0.086920440],
                [-0.040564731, 0.169055417],
                [-0.013370428, 0.059494268],
                [-0.042067830, -0.025697807],
                [0.056940679, -0.016546564],
                [-0.035946917, 0.018200785],
                [-0.031758223, 0.017098080],
                [0.084491402, -0.060112495],
                [0.499569982, -0.444381446],
                [0.506205320, -0.449881911],
                [0.257869959, -0.390967906],
                [-0.287185878, -0.129759431],
                [0.419900805, 0.006155007],
                [0.522761226, 0.449871212],
                [0.245047271, 0.419591278],
            ],
        ];
        const GAINS: [f32; 3] = [1.2, 1.8, 2.0];

        for mode in 0..3 {
            let mut samples = Vec::with_capacity(2048);
            for frame in 0..1024 {
                let time = frame as f32;
                samples.push(if frame == 0 {
                    0.8
                } else {
                    0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
                });
                samples.push(if frame == 0 {
                    -0.35
                } else {
                    -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
                });
            }
            let params = ClarityParams {
                enabled: true,
                mode: mode as i32,
                gain: GAINS[mode],
            };
            let mut clarity = ClarityProcessor::new(48_000, &params);
            clarity.process(&mut samples);

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[frame * 2 + channel] - EXPECTED[mode][position][channel]).abs()
                            <= 2.0e-6,
                        "mode {mode}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[mode][position][channel],
                        samples[frame * 2 + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn bass_modes_match_pcm_oracle() {
        const SELECTED: [usize; 17] = [
            0, 1, 2, 63, 255, 511, 767, 768, 769, 800, 1023, 1024, 1279, 1535, 1536, 1792, 2047,
        ];
        const EXPECTED: [[[f32; 2]; 17]; 3] = [
            [
                [0.800000012, -0.349999994],
                [0.086310379, -0.188783258],
                [0.102526717, -0.187034056],
                [-0.175530568, 0.232840076],
                [-0.224800229, -0.160169423],
                [-0.161435962, 0.056535400],
                [-0.259706855, 0.231567472],
                [-0.266858131, 0.232808188],
                [-0.272957087, 0.233505085],
                [0.016751971, 0.026929926],
                [-0.031254392, 0.157587275],
                [-0.046794645, 0.150908172],
                [0.023276765, -0.082547240],
                [0.223171502, -0.217227891],
                [0.212706551, -0.220804423],
                [0.208289400, -0.116409741],
                [0.178047568, 0.065105163],
            ],
            [
                [0.800000012, -0.349999994],
                [0.086310372, -0.188783258],
                [0.102526695, -0.187034041],
                [-0.175634474, 0.232857272],
                [-0.224808365, -0.160292611],
                [-0.161806852, 0.056359541],
                [-0.259313315, 0.231917366],
                [-0.001871200, 0.000818650],
                [-0.001860280, 0.001167114],
                [0.193853900, -0.176324159],
                [-0.087764770, -0.081512921],
                [-0.092827342, -0.081876464],
                [0.004515579, -0.045671456],
                [0.041887067, 0.034850240],
                [0.210724205, -0.222407371],
                [0.035653673, 0.038297318],
                [0.109770060, 0.070133261],
            ],
            [
                [0.800000012, -0.349999994],
                [0.086309470, -0.188781291],
                [0.102524556, -0.187030151],
                [-0.175495267, 0.232698008],
                [-0.224197447, -0.159819037],
                [-0.161031604, 0.056058872],
                [-0.257212877, 0.229907930],
                [-0.264290869, 0.231124029],
                [-0.270323962, 0.231799990],
                [0.017727975, 0.026303263],
                [-0.031855978, 0.156610727],
                [-0.047255091, 0.149983957],
                [0.024241710, -0.081483051],
                [0.217792198, -0.215006992],
                [0.207455888, -0.218511388],
                [0.206987560, -0.115010545],
                [0.172194898, 0.064965062],
            ],
        ];
        const GAINS: [f32; 3] = [2.8, 3.5, 2.0];

        for mode in 0..3 {
            let mut samples = Vec::with_capacity(4096);
            for frame in 0..2048 {
                let time = frame as f32;
                samples.push(if frame == 0 {
                    0.8
                } else {
                    0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
                });
                samples.push(if frame == 0 {
                    -0.35
                } else {
                    -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
                });
            }
            let params = BassParams {
                enabled: true,
                mode: mode as i32,
                frequency: 80.0,
                gain: GAINS[mode],
            };
            let mut bass = BassProcessor::new(48_000, &params);
            for block in samples.chunks_exact_mut(512) {
                bass.process(block);
            }

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[frame * 2 + channel] - EXPECTED[mode][position][channel]).abs()
                            <= 3.0e-6,
                        "mode {mode}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[mode][position][channel],
                        samples[frame * 2 + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn tube_matches_pcm_oracle() {
        const EXPECTED: [(usize, [f32; 2]); 18] = [
            (0, [0.800000012, -0.349999994]),
            (1, [0.086310372, -0.188783258]),
            (31, [0.250210941, 0.041483272]),
            (255, [-0.224808365, -0.160292611]),
            (1023, [-0.032497030, 0.158451632]),
            (4095, [0.158530444, 0.216884613]),
            (4998, [-0.005310643, -0.069874272]),
            (4999, [-0.022310350, -0.060546175]),
            (5000, [-0.055754282, -0.051722378]),
            (5001, [-0.080154955, -0.040936161]),
            (5002, [-0.094206423, -0.028968887]),
            (5010, [-0.229012713, 0.068421528]),
            (5050, [0.045458227, 0.215388671]),
            (5100, [-0.262781948, -0.193011343]),
            (5250, [0.278861701, 0.025244927]),
            (5500, [0.169231832, 0.134621993]),
            (5750, [0.020598400, 0.244081184]),
            (5999, [-0.312547296, 0.206776753]),
        ];
        let mut samples = Vec::with_capacity(12_000);
        for frame in 0..6000 {
            let time = frame as f32;
            samples.push(if frame == 0 {
                0.8
            } else {
                0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
            });
            samples.push(if frame == 0 {
                -0.35
            } else {
                -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
            });
        }
        let mut tube = TubeProcessor::new(48_000);
        for block in samples.chunks_exact_mut(480) {
            tube.process(block);
        }

        for (frame, expected) in EXPECTED {
            for channel in 0..2 {
                assert!(
                    (samples[frame * 2 + channel] - expected[channel]).abs() <= 3.0e-6,
                    "frame {frame}, channel {channel}: expected {}, got {}",
                    expected[channel],
                    samples[frame * 2 + channel]
                );
            }
        }
    }

    #[test]
    fn complete_vpf_chain_matches_pcm_oracle() {
        const EXPECTED: [(usize, [f32; 2]); 17] = [
            (0, [0.0, 0.0]),
            (255, [0.0, 0.0]),
            (256, [0.264506906, -0.128264010]),
            (257, [0.542654395, -0.302098244]),
            (511, [-0.340677738, -0.271056890]),
            (767, [-0.172951952, -0.016276276]),
            (1023, [-0.105966754, 0.197133675]),
            (1279, [0.148025304, 0.265053540]),
            (2047, [0.169652805, -0.093788616]),
            (3071, [-0.102346338, -0.119229205]),
            (4095, [0.260560602, 0.350935638]),
            (4999, [-0.286753118, -0.148429424]),
            (5000, [-0.300107539, -0.150291249]),
            (5119, [-0.037132129, -0.406524122]),
            (5500, [0.324452966, 0.136582717]),
            (6000, [0.081026375, 0.231278956]),
            (6143, [-0.145980820, 0.060403403]),
        ];
        let vpf = PreparedVpf {
            file_path: "full-chain.vpf".to_string(),
            params: VpfParams {
                bass: BassParams {
                    enabled: true,
                    mode: 0,
                    frequency: 80.0,
                    gain: 2.8,
                },
                clarity: ClarityParams {
                    enabled: true,
                    mode: 1,
                    gain: 1.8,
                },
                field: FieldParams {
                    enabled: true,
                    widening: 0.6,
                    mid_image: 1.3,
                },
                headphone: HeadphoneParams {
                    enabled: true,
                    level: 2,
                },
                reverb: ReverbParams {
                    enabled: true,
                    room_size: 0.7,
                    width: 0.6,
                    damping: 0.5,
                    wet: 0.4,
                    dry: 0.9,
                },
                equalizer: EqualizerParams {
                    enabled: true,
                    gains_db: [6.0, -3.0, 0.0, 2.5, -1.0, 4.0, -5.0, 1.0, 3.0, -2.0],
                },
                compressor: CompressorParams {
                    enabled: true,
                    threshold: 0.3,
                    ratio: 0.5,
                    knee: 0.6,
                    auto_knee: true,
                    gain: 0.1,
                    auto_gain: true,
                    attack: 0.514679,
                    auto_attack: true,
                    release: 0.384311,
                    auto_release: true,
                    knee_multi: 0.5,
                    max_attack: 0.87945,
                    max_release: 0.884311,
                    crest: 0.615689,
                    adapt: 0.660964,
                    no_clip: true,
                },
                playback: PlaybackParams {
                    enabled: true,
                    ratio: 0.5,
                    volume: 0.8,
                    max_scaler: 1.5,
                },
                crossfeed: CrossfeedParams {
                    enabled: true,
                    preset: 2,
                },
                tube_enabled: true,
                output_volume: 0.85,
            },
        };
        let mut samples = Vec::with_capacity(12_288);
        for frame in 0..6144 {
            let time = frame as f32;
            samples.push(if frame == 0 {
                0.8
            } else {
                0.23 * (time * 0.071).sin() + 0.07 * (time * 0.013).cos()
            });
            samples.push(if frame == 0 {
                -0.35
            } else {
                -0.19 * (time * 0.053).cos() + 0.05 * (time * 0.019).sin()
            });
        }
        let mut processor = VpfProcessor::new(48_000, &vpf);
        let vhe_latency = processor.headphone.latency_frames();
        samples.resize(samples.len() + vhe_latency * 2, 0.0);
        for block in samples.chunks_mut(512) {
            processor.process_interleaved(block);
        }

        for (frame, expected) in EXPECTED {
            for channel in 0..2 {
                assert!(
                    (samples[(frame + vhe_latency) * 2 + channel] - expected[channel]).abs()
                        <= 3.0e-5,
                    "frame {frame}, channel {channel}: expected {}, got {}",
                    expected[channel],
                    samples[(frame + vhe_latency) * 2 + channel]
                );
            }
        }
    }
}
