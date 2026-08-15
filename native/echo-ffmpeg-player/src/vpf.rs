use std::collections::VecDeque;
use std::fs;

#[cfg(test)]
use serde::Serialize;

// This processor owns the parameter-driven VPF stages. An optional external impulse response is
// prepared and processed by DspChain's spatial stage immediately before this processor.
const VPF_MAGIC: [u8; 14] = *b"ViPER4WindowsX";
// Mirrored by VPF_SECTION_SIZES in src/main/ipc/settings.ts for pre-download validation.
const SECTION_SIZES: [usize; 4] = [0x170, 0x2e4, 0x2e8, 0x31c];
const FREESTYLE_SECTION: usize = 3;
const MAX_VPF_BYTES: usize = 1024 * 1024;
const AUTO_COEFFICIENT_STEPS: usize = 256;
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
    pub gain_db: f32,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(Serialize))]
pub struct ClarityParams {
    pub enabled: bool,
    pub mode: i32,
    pub gain_db: f32,
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
    pub threshold_db: f32,
    pub ratio: f32,
    pub knee_db: f32,
    pub auto_knee: bool,
    pub gain_db: f32,
    pub auto_gain: bool,
    pub attack_ms: f32,
    pub auto_attack: bool,
    pub release_ms: f32,
    pub auto_release: bool,
    pub knee_multi: f32,
    pub max_attack_ms: f32,
    pub max_release_ms: f32,
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
            gain_db: read_f32(data, 0x220)?.clamp(-24.0, 24.0),
        },
        clarity: ClarityParams {
            enabled: read_bool(data, 0x224)?,
            mode: read_i32(data, 0x228)?,
            gain_db: read_f32(data, 0x22c)?.clamp(-24.0, 24.0),
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
            threshold_db: read_f32(data, 0x2d0)?.clamp(-120.0, 24.0),
            ratio: read_f32(data, 0x2d4)?.clamp(1.0, 40.0),
            knee_db: read_f32(data, 0x2d8)?.clamp(0.0, 48.0),
            auto_knee: read_bool(data, 0x2bc)?,
            gain_db: read_f32(data, 0x2dc)?.clamp(-24.0, 24.0),
            auto_gain: read_bool(data, 0x2c0)?,
            attack_ms: read_f32(data, 0x2e0)?.clamp(0.05, 2_000.0),
            auto_attack: read_bool(data, 0x2c4)?,
            release_ms: read_f32(data, 0x2e4)?.clamp(1.0, 10_000.0),
            auto_release: read_bool(data, 0x2c8)?,
            knee_multi: read_f32(data, 0x2e8)?.clamp(0.0, 10.0),
            max_attack_ms: read_f32(data, 0x2ec)?.clamp(0.05, 10_000.0),
            max_release_ms: read_f32(data, 0x2f0)?.clamp(1.0, 30_000.0),
            crest: read_f32(data, 0x2f4)?.clamp(0.0, 10.0),
            adapt: read_f32(data, 0x2f8)?.clamp(0.0, 10.0),
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
    eq: Vec<[Biquad; 2]>,
    bass: [Biquad; 2],
    clarity: [Biquad; 2],
    compressor_envelope: f32,
    playback_envelope: f32,
    compressor_attack_coefficient: f32,
    compressor_release_coefficient: f32,
    compressor_auto_attack_coefficients: Vec<f32>,
    compressor_auto_release_coefficients: Vec<f32>,
    surround_delay: VecDeque<(f32, f32)>,
    reverb: StereoReverb,
}

impl VpfProcessor {
    pub fn new(sample_rate: u32, vpf: &PreparedVpf) -> Self {
        let sample_rate = sample_rate.max(8_000) as f32;
        let eq = if vpf.params.equalizer.enabled {
            EQ_FREQUENCIES
                .iter()
                .zip(vpf.params.equalizer.gains_db)
                .filter(|(frequency, gain)| {
                    **frequency < sample_rate * 0.49 && gain.abs() > f32::EPSILON
                })
                .map(|(frequency, gain)| {
                    let filter = Biquad::peaking(sample_rate, *frequency, 1.414, gain);
                    [filter, filter]
                })
                .collect()
        } else {
            Vec::new()
        };
        let bass = match vpf.params.bass.mode {
            0 => Biquad::low_shelf(
                sample_rate,
                vpf.params.bass.frequency,
                vpf.params.bass.gain_db,
            ),
            1 => Biquad::peaking(
                sample_rate,
                vpf.params.bass.frequency,
                0.707,
                vpf.params.bass.gain_db,
            ),
            _ => Biquad::peaking(
                sample_rate,
                vpf.params.bass.frequency,
                1.414,
                vpf.params.bass.gain_db,
            ),
        };
        let clarity_frequency: f32 = match vpf.params.clarity.mode {
            0 => 3_500.0,
            1 => 6_000.0,
            _ => 9_000.0,
        };
        let clarity = Biquad::high_shelf(
            sample_rate,
            clarity_frequency.min(sample_rate * 0.45),
            vpf.params.clarity.gain_db,
        );
        let surround_frames =
            ((sample_rate * (0.004 + vpf.params.headphone.level as f32 * 0.0015)) as usize).max(1);
        let compressor_attack_coefficient =
            time_coefficient(sample_rate, vpf.params.compressor.attack_ms);
        let compressor_release_coefficient =
            time_coefficient(sample_rate, vpf.params.compressor.release_ms);
        let compressor_auto_attack_coefficients = if vpf.params.compressor.auto_attack {
            (0..=AUTO_COEFFICIENT_STEPS)
                .map(|step| {
                    let activity = step as f32 / AUTO_COEFFICIENT_STEPS as f32;
                    time_coefficient(
                        sample_rate,
                        compressor_attack_ms(&vpf.params.compressor, activity),
                    )
                })
                .collect()
        } else {
            Vec::new()
        };
        let compressor_auto_release_coefficients = if vpf.params.compressor.auto_release {
            (0..=AUTO_COEFFICIENT_STEPS)
                .map(|step| {
                    let activity = step as f32 / AUTO_COEFFICIENT_STEPS as f32;
                    time_coefficient(
                        sample_rate,
                        compressor_release_ms(&vpf.params.compressor, activity),
                    )
                })
                .collect()
        } else {
            Vec::new()
        };
        Self {
            params: vpf.params.clone(),
            eq,
            bass: [bass, bass],
            clarity: [clarity, clarity],
            compressor_envelope: 0.0,
            playback_envelope: 0.0,
            compressor_attack_coefficient,
            compressor_release_coefficient,
            compressor_auto_attack_coefficients,
            compressor_auto_release_coefficients,
            surround_delay: VecDeque::from(vec![(0.0, 0.0); surround_frames]),
            reverb: StereoReverb::new(sample_rate as u32),
        }
    }

    pub fn process_interleaved(&mut self, samples: &mut [f32]) {
        for frame in samples.chunks_exact_mut(2) {
            let mut left = frame[0];
            let mut right = frame[1];

            if self.params.headphone.enabled {
                self.surround_delay.push_back((left, right));
                let (delayed_left, delayed_right) =
                    self.surround_delay.pop_front().unwrap_or_default();
                let amount = 0.08 + self.params.headphone.level as f32 * 0.035;
                left -= delayed_right * amount;
                right -= delayed_left * amount;
            }
            for band in &mut self.eq {
                left = band[0].process(left);
                right = band[1].process(right);
            }
            if self.params.field.enabled {
                let mid = (left + right) * 0.5 * self.params.field.mid_image;
                let side = (left - right) * 0.5 * (1.0 + self.params.field.widening);
                left = mid + side;
                right = mid - side;
            }
            if self.params.playback.enabled {
                let peak = left.abs().max(right.abs());
                self.playback_envelope = self.playback_envelope * 0.995 + peak * 0.005;
                let target = self.params.playback.volume.max(0.01);
                let scaler = (target / self.playback_envelope.max(0.01))
                    .powf(self.params.playback.ratio.clamp(0.0, 1.0))
                    .min(self.params.playback.max_scaler.max(1.0));
                left *= scaler;
                right *= scaler;
            }
            if self.params.compressor.enabled {
                let peak = left.abs().max(right.abs()).max(1e-9);
                let input_db = 20.0 * peak.log10();
                let activity =
                    ((input_db - self.params.compressor.threshold_db) / 24.0).clamp(0.0, 1.0);
                let coefficient_index = (activity * AUTO_COEFFICIENT_STEPS as f32).round() as usize;
                let attack = self
                    .compressor_auto_attack_coefficients
                    .get(coefficient_index)
                    .copied()
                    .unwrap_or(self.compressor_attack_coefficient);
                let release = self
                    .compressor_auto_release_coefficients
                    .get(coefficient_index)
                    .copied()
                    .unwrap_or(self.compressor_release_coefficient);
                let coefficient = if peak > self.compressor_envelope {
                    attack
                } else {
                    release
                };
                self.compressor_envelope =
                    coefficient * self.compressor_envelope + (1.0 - coefficient) * peak;
                let envelope_db = 20.0 * self.compressor_envelope.max(1e-9).log10();
                let knee_db = if self.params.compressor.auto_knee {
                    self.params.compressor.knee_db
                        * self.params.compressor.knee_multi.max(1.0)
                        * (1.0 + activity * self.params.compressor.adapt * 0.1)
                } else {
                    self.params.compressor.knee_db
                };
                let over =
                    soft_knee_over(envelope_db, self.params.compressor.threshold_db, knee_db);
                let reduction = over * (1.0 - 1.0 / self.params.compressor.ratio.max(1.0));
                let auto_gain = if self.params.compressor.auto_gain {
                    -self.params.compressor.threshold_db * 0.25
                } else {
                    0.0
                };
                let gain = db_to_gain(self.params.compressor.gain_db + auto_gain - reduction);
                left *= gain;
                right *= gain;
                if self.params.compressor.no_clip && input_db > 0.0 {
                    let trim = db_to_gain(-input_db);
                    left *= trim;
                    right *= trim;
                }
            }
            if self.params.tube_enabled {
                left = tube(left);
                right = tube(right);
            }
            if self.params.bass.enabled {
                left = self.bass[0].process(left);
                right = self.bass[1].process(right);
            }
            if self.params.clarity.enabled {
                left = self.clarity[0].process(left);
                right = self.clarity[1].process(right);
            }
            if self.params.crossfeed.enabled {
                let amount = [0.08, 0.13, 0.18][self.params.crossfeed.preset as usize];
                let next_left = left + right * amount;
                let next_right = right + left * amount;
                left = next_left / (1.0 + amount);
                right = next_right / (1.0 + amount);
            }
            if self.params.reverb.enabled {
                let (wet_left, wet_right) = self.reverb.process(
                    left,
                    right,
                    self.params.reverb.room_size,
                    self.params.reverb.damping,
                    self.params.reverb.width,
                );
                left = left * self.params.reverb.dry + wet_left * self.params.reverb.wet;
                right = right * self.params.reverb.dry + wet_right * self.params.reverb.wet;
            }

            // VPF owns its format-defined limiter. The graph-level limiter remains a separate
            // player safety boundary for normalization, tempo and output-device processing.
            frame[0] = limiter(left * self.params.output_volume);
            frame[1] = limiter(right * self.params.output_volume);
        }
    }

    pub fn latency_frames(&self) -> usize {
        // VHE mixes a delayed cross-channel component with the current dry frame, and reverb delay
        // is an audible effect tail. Neither stage holds the complete signal before producing output.
        0
    }
}

fn compressor_attack_ms(params: &CompressorParams, activity: f32) -> f32 {
    let crest_weight = 1.0 / (1.0 + params.crest);
    params.attack_ms
        + (params.max_attack_ms - params.attack_ms).max(0.0) * (1.0 - activity) * crest_weight
}

fn compressor_release_ms(params: &CompressorParams, activity: f32) -> f32 {
    let adapt_weight = params.adapt / (1.0 + params.adapt);
    params.release_ms
        + (params.max_release_ms - params.release_ms).max(0.0) * activity * adapt_weight
}

fn time_coefficient(sample_rate: f32, milliseconds: f32) -> f32 {
    (-1.0 / (sample_rate * milliseconds.max(0.01) * 0.001)).exp()
}

fn soft_knee_over(level: f32, threshold: f32, knee: f32) -> f32 {
    if knee <= 0.0 {
        return (level - threshold).max(0.0);
    }
    let lower = threshold - knee * 0.5;
    let upper = threshold + knee * 0.5;
    if level <= lower {
        0.0
    } else if level >= upper {
        level - threshold
    } else {
        let distance = level - lower;
        distance * distance / (2.0 * knee)
    }
}

fn db_to_gain(db: f32) -> f32 {
    10.0f32.powf(db / 20.0)
}

fn tube(value: f32) -> f32 {
    (value * 1.6).tanh() / 1.6f32.tanh()
}

fn limiter(value: f32) -> f32 {
    const KNEE: f32 = 0.95;
    const RANGE: f32 = 1.0 - KNEE;
    if !value.is_finite() {
        return 0.0;
    }
    let magnitude = value.abs();
    if magnitude <= KNEE {
        return value;
    }
    let limited = KNEE + RANGE * (1.0 - (-(magnitude - KNEE) / RANGE).exp());
    value.signum() * limited.min(1.0)
}

#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn peaking(sample_rate: f32, frequency: f32, q: f32, gain_db: f32) -> Self {
        let a = 10.0f32.powf(gain_db / 40.0);
        let omega = 2.0 * std::f32::consts::PI * frequency / sample_rate;
        let alpha = omega.sin() / (2.0 * q.max(0.1));
        Self::normalized(
            1.0 + alpha * a,
            -2.0 * omega.cos(),
            1.0 - alpha * a,
            1.0 + alpha / a,
            -2.0 * omega.cos(),
            1.0 - alpha / a,
        )
    }

    fn low_shelf(sample_rate: f32, frequency: f32, gain_db: f32) -> Self {
        Self::shelf(sample_rate, frequency, gain_db, false)
    }

    fn high_shelf(sample_rate: f32, frequency: f32, gain_db: f32) -> Self {
        Self::shelf(sample_rate, frequency, gain_db, true)
    }

    fn shelf(sample_rate: f32, frequency: f32, gain_db: f32, high: bool) -> Self {
        let a = 10.0f32.powf(gain_db / 40.0);
        let omega =
            2.0 * std::f32::consts::PI * frequency.clamp(10.0, sample_rate * 0.49) / sample_rate;
        let cos = omega.cos();
        let alpha = omega.sin() / std::f32::consts::SQRT_2;
        let root = 2.0 * a.sqrt() * alpha;
        let (b0, b1, b2, a0, a1, a2) = if high {
            (
                a * ((a + 1.0) + (a - 1.0) * cos + root),
                -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                a * ((a + 1.0) + (a - 1.0) * cos - root),
                (a + 1.0) - (a - 1.0) * cos + root,
                2.0 * ((a - 1.0) - (a + 1.0) * cos),
                (a + 1.0) - (a - 1.0) * cos - root,
            )
        } else {
            (
                a * ((a + 1.0) - (a - 1.0) * cos + root),
                2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                a * ((a + 1.0) - (a - 1.0) * cos - root),
                (a + 1.0) + (a - 1.0) * cos + root,
                -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                (a + 1.0) + (a - 1.0) * cos - root,
            )
        };
        Self::normalized(b0, b1, b2, a0, a1, a2)
    }

    fn normalized(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * output + self.z2;
        self.z2 = self.b2 * input - self.a2 * output;
        output
    }
}

struct StereoReverb {
    left: Vec<f32>,
    right: Vec<f32>,
    index: usize,
    low_left: f32,
    low_right: f32,
}

impl StereoReverb {
    fn new(sample_rate: u32) -> Self {
        let frames = ((sample_rate as f32 * 0.091) as usize).max(64);
        Self {
            left: vec![0.0; frames],
            right: vec![0.0; frames + 127],
            index: 0,
            low_left: 0.0,
            low_right: 0.0,
        }
    }

    fn process(
        &mut self,
        left: f32,
        right: f32,
        room: f32,
        damping: f32,
        width: f32,
    ) -> (f32, f32) {
        let left_index = self.index % self.left.len();
        let right_index = self.index % self.right.len();
        let delayed_left = self.left[left_index];
        let delayed_right = self.right[right_index];
        self.low_left += (delayed_left - self.low_left) * (1.0 - damping * 0.85);
        self.low_right += (delayed_right - self.low_right) * (1.0 - damping * 0.85);
        let feedback = 0.25 + room * 0.7;
        self.left[left_index] = left + self.low_right * feedback;
        self.right[right_index] = right + self.low_left * feedback;
        self.index = self.index.wrapping_add(1);
        let mid = (delayed_left + delayed_right) * 0.5;
        let side = (delayed_left - delayed_right) * 0.5 * width;
        (mid + side, mid - side)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const REAL_SAMPLE_GOLDEN_FINGERPRINTS: [(&str, u64); 22] = [
        ("7277.vpf", 0xf642_df00_1f6c_cbc2),
        ("7617.vpf", 0x0780_f937_526a_0c14),
        ("7675.vpf", 0x4151_d561_4271_0ec3),
        ("7803.vpf", 0x01e2_cdf6_4794_6c78),
        ("7823.vpf", 0x4a2e_cddb_5bc9_dcb2),
        ("7829.vpf", 0xa146_9288_006e_e319),
        ("7841.vpf", 0x665a_6d88_7285_6a4c),
        ("7983.vpf", 0xd974_93dd_2d75_97d5),
        ("8007.vpf", 0x3d53_c4fd_ebe8_0015),
        ("8025.vpf", 0x539e_e5d6_fb74_21f0),
        ("8029.vpf", 0x2ecb_c68c_616f_bde5),
        ("8033.vpf", 0x7186_b81b_f17b_1fc1),
        ("8035.vpf", 0xf040_a357_bff3_8fb9),
        ("8039.vpf", 0x8ad7_5234_3ee3_8d48),
        ("8041.vpf", 0x8edd_9eaf_050c_ead0),
        ("8045.vpf", 0x2430_5bbb_e9b9_8e10),
        ("8053.vpf", 0x3dfd_03de_efb4_e1e3),
        ("8055.vpf", 0xdbc2_d9ee_4a56_fe95),
        ("8059.vpf", 0x7264_bbc3_4955_439c),
        ("8061.vpf", 0x3c8d_88d1_a4e8_a7f4),
        ("8071.vpf", 0x4d0c_94d7_a45c_bf1a),
        ("8075.vpf", 0xf7a9_ff91_4239_7ce0),
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

        for (file_name, expected_fingerprint) in REAL_SAMPLE_GOLDEN_FINGERPRINTS {
            let data =
                fs::read(corpus.join(file_name)).expect("real VPF sample should be readable");
            let params = parse_vpf(&data).expect("real VPF sample should parse");
            let snapshot = serde_json::to_vec(&params).expect("VPF snapshot should serialize");
            let actual_fingerprint = fnv1a(&snapshot);
            assert_eq!(actual_fingerprint, expected_fingerprint, "{file_name}");
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
        put_f32(section, 0x2d0, -18.0);
        put_f32(section, 0x2d4, 4.0);
        put_f32(section, 0x2d8, 6.0);
        put_f32(section, 0x2dc, 2.0);
        put_f32(section, 0x2e0, 5.0);
        put_f32(section, 0x2e4, 200.0);
        put_f32(section, 0x2e8, 1.5);
        put_f32(section, 0x2ec, 50.0);
        put_f32(section, 0x2f0, 1_000.0);
        put_f32(section, 0x2f4, 2.0);
        put_f32(section, 0x2f8, 3.0);
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
                gain_db: 3.5
            }
        );
        assert_eq!(
            params.clarity,
            ClarityParams {
                enabled: true,
                mode: 1,
                gain_db: 2.5
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
                threshold_db: -18.0,
                ratio: 4.0,
                knee_db: 6.0,
                auto_knee: true,
                gain_db: 2.0,
                auto_gain: true,
                attack_ms: 5.0,
                auto_attack: true,
                release_ms: 200.0,
                auto_release: true,
                knee_multi: 1.5,
                max_attack_ms: 50.0,
                max_release_ms: 1_000.0,
                crest: 2.0,
                adapt: 3.0,
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
    fn zero_db_equalizer_builds_no_filters() {
        let params = parse_vpf(&synthetic_vpf()).expect("VPF should parse");
        let vpf = PreparedVpf {
            file_path: "test.vpf".to_string(),
            params,
        };
        let processor = VpfProcessor::new(48_000, &vpf);
        assert!(processor.eq.is_empty());
        assert_eq!(processor.latency_frames(), 0);
    }
}
