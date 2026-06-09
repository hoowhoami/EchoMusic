use crate::decode::AudioFormat;
use crate::error::{clamp_f64, PlayerError, PlayerResult};
use fft_convolver::FFTConvolver;
use rt_fft_convolver::load_ir;
use signalsmith_stretch::Stretch;
use std::f32::consts::PI;
use std::path::Path;

pub const EQ_BAND_COUNT: usize = 10;
pub const EQ_FREQUENCIES: [f32; EQ_BAND_COUNT] = [
    60.0, 170.0, 310.0, 600.0, 1_000.0, 3_000.0, 6_000.0, 12_000.0, 14_000.0, 16_000.0,
];

const EQ_Q: f32 = 1.0;
const MIN_FILTER_FREQ_RATIO: f32 = 0.45;
const CONVOLUTION_BLOCK_SIZE: usize = 1024;
const MAX_IR_SECONDS: usize = 12;
const IMPULSE_RESPONSE_WET_MAKEUP: f32 = 3.0;

#[derive(Clone, Debug, PartialEq)]
pub struct ImpulseResponseSettings {
    pub path: String,
    pub mix: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DspSettings {
    pub equalizer_gains_db: [f32; EQ_BAND_COUNT],
    pub normalization_gain_db: f32,
    pub impulse_response: Option<ImpulseResponseSettings>,
    pub speed: f32,
}

impl Default for DspSettings {
    fn default() -> Self {
        Self {
            equalizer_gains_db: [0.0; EQ_BAND_COUNT],
            normalization_gain_db: 0.0,
            impulse_response: None,
            speed: 1.0,
        }
    }
}

impl DspSettings {
    pub fn from_values(
        gains: &[f64; EQ_BAND_COUNT],
        gain_db: f64,
        impulse_response: Option<ImpulseResponseSettings>,
        speed: f64,
    ) -> PlayerResult<Self> {
        let mut equalizer_gains_db = [0.0; EQ_BAND_COUNT];
        for (index, gain) in gains.iter().enumerate() {
            equalizer_gains_db[index] = clamp_f64(*gain, -12.0, 12.0)? as f32;
        }
        Ok(Self {
            equalizer_gains_db,
            normalization_gain_db: clamp_f64(gain_db, -36.0, 36.0)? as f32,
            impulse_response,
            speed: clamp_f64(speed, 0.1, 5.0)? as f32,
        })
    }
}

pub struct DspProcessor {
    sample_rate: u32,
    channels: usize,
    settings: DspSettings,
    filters: Vec<[Biquad; EQ_BAND_COUNT]>,
    normalization_gain: f32,
    convolution: ConvolutionProcessor,
    tempo: TempoProcessor,
}

impl DspProcessor {
    pub fn new() -> Self {
        Self {
            sample_rate: 0,
            channels: 0,
            settings: DspSettings::default(),
            filters: Vec::new(),
            normalization_gain: 1.0,
            convolution: ConvolutionProcessor::new(),
            tempo: TempoProcessor::new(),
        }
    }

    pub fn reset(&mut self) {
        self.convolution.reset();
        self.tempo.reset();
    }

    pub fn process(
        &mut self,
        samples: &mut Vec<f32>,
        format: &AudioFormat,
        settings: &DspSettings,
    ) -> PlayerResult<()> {
        let channels = format.channels.max(1);
        if self.sample_rate != format.sample_rate
            || self.channels != channels
            || self.settings.equalizer_gains_db != settings.equalizer_gains_db
            || self.settings.normalization_gain_db != settings.normalization_gain_db
        {
            self.rebuild_eq_and_gain(format.sample_rate, channels, settings);
        }

        for frame in samples.chunks_mut(channels) {
            for (channel, sample) in frame.iter_mut().enumerate() {
                let mut value = *sample;
                if let Some(filters) = self.filters.get_mut(channel) {
                    for filter in filters.iter_mut() {
                        value = filter.process(value);
                    }
                }
                *sample = value * self.normalization_gain;
            }
        }

        self.convolution.process(
            samples,
            format.sample_rate,
            channels,
            settings.impulse_response.as_ref(),
        )?;
        self.tempo
            .process(samples, format.sample_rate, channels, settings.speed)?;

        self.settings = settings.clone();
        Ok(())
    }

    fn rebuild_eq_and_gain(&mut self, sample_rate: u32, channels: usize, settings: &DspSettings) {
        self.sample_rate = sample_rate.max(1);
        self.channels = channels.max(1);
        self.normalization_gain = db_to_gain(settings.normalization_gain_db);
        self.filters = (0..self.channels)
            .map(|_| build_filter_bank(self.sample_rate, settings))
            .collect();
    }
}

pub fn parse_audio_filter_settings(filter: &str) -> PlayerResult<Option<DspSettings>> {
    let trimmed = filter.trim();
    if trimmed.is_empty() {
        return Ok(Some(DspSettings::default()));
    }

    let mut settings = DspSettings::default();
    let mut recognized = false;

    if let Some(ir) = parse_impulse_response_filter(trimmed)? {
        settings.impulse_response = Some(ir);
        recognized = true;
    }

    for part in find_filter_parts(trimmed, "equalizer=") {
        if let Some((frequency, gain)) = parse_equalizer_filter(part)? {
            if let Some(index) = nearest_eq_band(frequency) {
                settings.equalizer_gains_db[index] = gain;
                recognized = true;
            }
        }
    }

    for part in find_filter_parts(trimmed, "volume=") {
        if let Some(gain_db) = parse_volume_filter(part)? {
            settings.normalization_gain_db = gain_db;
            recognized = true;
        }
    }

    Ok(recognized.then_some(settings))
}

fn build_filter_bank(sample_rate: u32, settings: &DspSettings) -> [Biquad; EQ_BAND_COUNT] {
    let mut filters = [Biquad::identity(); EQ_BAND_COUNT];
    for (index, frequency) in EQ_FREQUENCIES.iter().enumerate() {
        filters[index] = Biquad::peaking(
            *frequency,
            sample_rate as f32,
            EQ_Q,
            settings.equalizer_gains_db[index],
        );
    }
    filters
}

fn find_filter_parts<'a>(filter: &'a str, prefix: &str) -> Vec<&'a str> {
    let mut parts = Vec::new();
    let mut rest = filter;
    while let Some(index) = rest.find(prefix) {
        let start = index;
        let after = &rest[start..];
        let end = after.find(',').unwrap_or(after.len());
        parts.push(&after[..end]);
        rest = &after[end..];
    }
    parts
}

fn parse_equalizer_filter(part: &str) -> PlayerResult<Option<(f32, f32)>> {
    let Some(body) = part.strip_prefix("equalizer=") else {
        return Ok(None);
    };

    let mut frequency = None;
    let mut gain = None;
    for token in body.split(':') {
        if let Some(value) = token.strip_prefix("f=") {
            frequency = value.parse::<f32>().ok();
        } else if let Some(value) = token.strip_prefix("g=") {
            gain = value.parse::<f32>().ok();
        }
    }

    match (frequency, gain) {
        (Some(frequency), Some(gain)) => Ok(Some((
            frequency,
            clamp_f64(f64::from(gain), -12.0, 12.0)? as f32,
        ))),
        _ => Err(PlayerError::InvalidInput(format!(
            "invalid equalizer filter: {part}"
        ))),
    }
}

fn parse_volume_filter(part: &str) -> PlayerResult<Option<f32>> {
    let Some(value) = part.strip_prefix("volume=") else {
        return Ok(None);
    };
    let Some(db_value) = value.strip_suffix("dB") else {
        return Err(PlayerError::Unsupported(format!(
            "unsupported volume filter: {part}"
        )));
    };
    let gain_db = db_value
        .parse::<f64>()
        .map_err(|_| PlayerError::InvalidInput(format!("invalid volume filter: {part}")))?;
    Ok(Some(clamp_f64(gain_db, -36.0, 36.0)? as f32))
}

fn parse_impulse_response_filter(filter: &str) -> PlayerResult<Option<ImpulseResponseSettings>> {
    if !filter.contains("lavfi") || !filter.contains("amovie=") || !filter.contains("afir") {
        return Ok(None);
    }

    let graph = extract_lavfi_graph(filter).unwrap_or(filter);
    let Some(path) = extract_quoted_value(graph, "amovie='") else {
        return Err(PlayerError::InvalidInput(
            "impulse response filter is missing amovie path".to_string(),
        ));
    };
    let mix = extract_quoted_value(graph, "weights='")
        .and_then(|weights| {
            weights
                .split_whitespace()
                .nth(1)
                .and_then(|value| value.parse::<f32>().ok())
        })
        .unwrap_or(0.4)
        .clamp(0.0, 1.0);

    Ok(Some(ImpulseResponseSettings {
        path: unescape_lavfi_path(&path),
        mix,
    }))
}

fn extract_lavfi_graph(filter: &str) -> Option<&str> {
    let graph_start = filter.find("lavfi=graph=")? + "lavfi=graph=".len();
    let graph = &filter[graph_start..];
    let Some(after_percent) = graph.strip_prefix('%') else {
        return Some(graph);
    };
    let digit_count = after_percent
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digit_count == 0 || after_percent.as_bytes().get(digit_count) != Some(&b'%') {
        return Some(graph);
    }

    let byte_len = after_percent[..digit_count].parse::<usize>().ok()?;
    let payload = &after_percent[digit_count + 1..];
    byte_prefix_slice(payload, byte_len).or(Some(payload))
}

fn byte_prefix_slice(value: &str, byte_len: usize) -> Option<&str> {
    if byte_len > value.len() || !value.is_char_boundary(byte_len) {
        return None;
    }
    Some(&value[..byte_len])
}

fn extract_quoted_value(value: &str, prefix: &str) -> Option<String> {
    let start = value.find(prefix)? + prefix.len();
    let mut escaped = false;
    let mut output = String::new();
    for character in value[start..].chars() {
        if escaped {
            output.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '\'' {
            return Some(output);
        }
        output.push(character);
    }
    None
}

fn unescape_lavfi_path(path: &str) -> String {
    path.replace("\\:", ":").replace("\\'", "'")
}

fn nearest_eq_band(frequency: f32) -> Option<usize> {
    EQ_FREQUENCIES
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            ((*left - frequency).abs())
                .partial_cmp(&(*right - frequency).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .and_then(|(index, band)| {
            let tolerance = (*band * 0.05).max(1.0);
            ((*band - frequency).abs() <= tolerance).then_some(index)
        })
}

fn db_to_gain(gain_db: f32) -> f32 {
    10.0_f32.powf(gain_db / 20.0)
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
    active: bool,
}

impl Biquad {
    const fn identity() -> Self {
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: 0.0,
            z2: 0.0,
            active: false,
        }
    }

    fn peaking(frequency: f32, sample_rate: f32, q: f32, gain_db: f32) -> Self {
        if gain_db.abs() < 0.001
            || frequency <= 0.0
            || sample_rate <= 0.0
            || frequency >= sample_rate * MIN_FILTER_FREQ_RATIO
        {
            return Self::identity();
        }

        let a = 10.0_f32.powf(gain_db / 40.0);
        let omega = 2.0 * PI * frequency / sample_rate;
        let sin = omega.sin();
        let cos = omega.cos();
        let alpha = sin / (2.0 * q.max(0.001));

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos;
        let a2 = 1.0 - alpha / a;

        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
            active: true,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        if !self.active {
            return input;
        }
        let output = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * output + self.z2;
        self.z2 = self.b2 * input - self.a2 * output;
        output
    }
}

struct ConvolutionProcessor {
    path: Option<String>,
    sample_rate: u32,
    channels: usize,
    convolvers: Vec<FFTConvolver<f32>>,
    dry: Vec<f32>,
    wet: Vec<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
}

impl ConvolutionProcessor {
    fn new() -> Self {
        Self {
            path: None,
            sample_rate: 0,
            channels: 0,
            convolvers: Vec::new(),
            dry: Vec::new(),
            wet: Vec::new(),
            input: Vec::new(),
            output: Vec::new(),
        }
    }

    fn reset(&mut self) {
        self.path = None;
        self.convolvers.clear();
        self.dry.clear();
        self.wet.clear();
        self.input.clear();
        self.output.clear();
    }

    fn process(
        &mut self,
        samples: &mut [f32],
        sample_rate: u32,
        channels: usize,
        settings: Option<&ImpulseResponseSettings>,
    ) -> PlayerResult<()> {
        let Some(settings) = settings else {
            self.reset();
            return Ok(());
        };
        if settings.mix <= 0.0 || settings.path.trim().is_empty() {
            self.reset();
            return Ok(());
        }

        self.ensure_loaded(&settings.path, sample_rate, channels)?;
        let frames = samples.len() / channels.max(1);
        if frames == 0 {
            return Ok(());
        }

        self.dry.resize(samples.len(), 0.0);
        self.dry.copy_from_slice(samples);
        self.wet.resize(samples.len(), 0.0);
        self.wet.fill(0.0);
        self.input.resize(frames, 0.0);
        self.output.resize(frames, 0.0);

        for channel in 0..channels {
            for frame in 0..frames {
                self.input[frame] = samples[frame * channels + channel];
            }
            self.output.fill(0.0);
            self.convolvers[channel]
                .process(&self.input, &mut self.output)
                .map_err(|err| PlayerError::Backend(format!("IR convolution failed: {err}")))?;
            for frame in 0..frames {
                self.wet[frame * channels + channel] = self.output[frame];
            }
        }

        let wet_mix = settings.mix * IMPULSE_RESPONSE_WET_MAKEUP;
        for (sample, (dry, wet)) in samples.iter_mut().zip(self.dry.iter().zip(self.wet.iter())) {
            *sample = *dry + *wet * wet_mix;
        }
        Ok(())
    }

    fn ensure_loaded(&mut self, path: &str, sample_rate: u32, channels: usize) -> PlayerResult<()> {
        let normalized_path = path.trim();
        if self.path.as_deref() == Some(normalized_path)
            && self.sample_rate == sample_rate
            && self.channels == channels
            && self.convolvers.len() == channels
        {
            return Ok(());
        }

        if !Path::new(normalized_path).exists() {
            return Err(PlayerError::InvalidInput(format!(
                "impulse response file not found: {normalized_path}"
            )));
        }

        let mut ir = load_ir(normalized_path, sample_rate).map_err(|err| {
            PlayerError::Backend(format!("failed to load impulse response: {err}"))
        })?;
        trim_ir_channels(&mut ir.channels, sample_rate);
        normalize_ir_channels(&mut ir.channels);

        self.convolvers.clear();
        for channel in 0..channels {
            let ir_channel = select_ir_channel(&ir.channels, channel)
                .ok_or_else(|| PlayerError::Backend("impulse response is empty".to_string()))?;
            let mut convolver = FFTConvolver::<f32>::default();
            convolver
                .init(CONVOLUTION_BLOCK_SIZE, ir_channel)
                .map_err(|err| PlayerError::Backend(format!("IR convolver init failed: {err}")))?;
            self.convolvers.push(convolver);
        }

        self.path = Some(normalized_path.to_string());
        self.sample_rate = sample_rate;
        self.channels = channels;
        Ok(())
    }
}

fn select_ir_channel(channels: &[Vec<f32>], output_channel: usize) -> Option<&[f32]> {
    if channels.is_empty() {
        return None;
    }
    if channels.len() == 1 {
        return Some(channels[0].as_slice());
    }
    channels
        .get(output_channel.min(channels.len() - 1))
        .map(Vec::as_slice)
}

fn trim_ir_channels(channels: &mut [Vec<f32>], sample_rate: u32) {
    let max_len = sample_rate as usize * MAX_IR_SECONDS;
    for channel in channels {
        if channel.len() > max_len {
            channel.truncate(max_len);
        }
    }
}

fn normalize_ir_channels(channels: &mut [Vec<f32>]) {
    let peak = channels
        .iter()
        .flat_map(|channel| channel.iter())
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    if peak <= 1.0 || peak <= f32::EPSILON {
        return;
    }
    for channel in channels {
        for sample in channel {
            *sample /= peak;
        }
    }
}

struct TempoProcessor {
    sample_rate: u32,
    channels: usize,
    speed: f32,
    stretch: Option<Stretch>,
}

impl TempoProcessor {
    fn new() -> Self {
        Self {
            sample_rate: 0,
            channels: 0,
            speed: 1.0,
            stretch: None,
        }
    }

    fn reset(&mut self) {
        if let Some(stretch) = self.stretch.as_mut() {
            stretch.reset();
        }
    }

    fn process(
        &mut self,
        samples: &mut Vec<f32>,
        sample_rate: u32,
        channels: usize,
        speed: f32,
    ) -> PlayerResult<()> {
        let speed = speed.clamp(0.1, 5.0);
        if (speed - 1.0).abs() < 0.001 || samples.is_empty() {
            self.speed = speed;
            return Ok(());
        }

        self.ensure_stretcher(sample_rate, channels, speed);
        let frames = samples.len() / channels;
        let output_frames = ((frames as f32 / speed).round() as usize).max(1);
        let mut output = vec![0.0; output_frames * channels];
        self.stretch
            .as_mut()
            .ok_or_else(|| PlayerError::State("tempo stretcher is not initialized".to_string()))?
            .process(samples.as_slice(), output.as_mut_slice());
        *samples = output;
        Ok(())
    }

    fn ensure_stretcher(&mut self, sample_rate: u32, channels: usize, speed: f32) {
        if self.sample_rate == sample_rate
            && self.channels == channels
            && (self.speed - speed).abs() < 0.001
            && self.stretch.is_some()
        {
            return;
        }

        let mut stretch = Stretch::preset_default(channels as u32, sample_rate);
        stretch.set_transpose_factor(1.0, None);
        self.stretch = Some(stretch);
        self.sample_rate = sample_rate;
        self.channels = channels;
        self.speed = speed;
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_audio_filter_settings, DspProcessor, DspSettings, ImpulseResponseSettings};
    use crate::decode::AudioFormat;
    use std::fs;
    use std::io::Write;

    #[test]
    fn parses_player_equalizer_volume_and_ir_filters() {
        let graph =
            "[in]asplit=2[dry][in2];amovie='/tmp/room\\:a.wav'[ir];[dry][in2]afir[wet];[dry][wet]amix@irsmix=inputs=2:weights='1 0.35':normalize=0[out]";
        let filter = format!(
            "@irs:lavfi=graph=%{}%{},equalizer=f=60:g=3:w=1,volume=-4.5dB",
            graph.len(),
            graph
        );
        let settings = parse_audio_filter_settings(&filter)
            .expect("filter should parse")
            .expect("filter should be recognized");

        assert_eq!(settings.equalizer_gains_db[0], 3.0);
        assert_eq!(settings.normalization_gain_db, -4.5);
        assert_eq!(
            settings
                .impulse_response
                .as_ref()
                .map(|ir| ir.path.as_str()),
            Some("/tmp/room:a.wav")
        );
        assert_eq!(
            settings.impulse_response.as_ref().map(|ir| ir.mix),
            Some(0.35)
        );
    }

    #[test]
    fn normalization_gain_changes_pcm_level() {
        let mut processor = DspProcessor::new();
        let mut samples = vec![0.25, -0.25, 0.5, -0.5];
        processor
            .process(
                &mut samples,
                &AudioFormat {
                    sample_rate: 48_000,
                    channels: 2,
                },
                &DspSettings {
                    normalization_gain_db: 6.0,
                    ..DspSettings::default()
                },
            )
            .expect("DSP should process");

        assert!(samples[0] > 0.49);
        assert!(samples[1] < -0.49);
    }

    #[test]
    fn tempo_speed_changes_output_length() {
        let mut processor = DspProcessor::new();
        let mut samples = vec![0.0; 48_000 * 2];
        processor
            .process(
                &mut samples,
                &AudioFormat {
                    sample_rate: 48_000,
                    channels: 2,
                },
                &DspSettings {
                    speed: 2.0,
                    ..DspSettings::default()
                },
            )
            .expect("tempo should process");

        assert!(samples.len() < 48_000 * 2);
    }

    #[test]
    fn impulse_response_convolution_mixes_wet_signal() {
        let path = std::env::temp_dir().join(format!(
            "echo-ffmpeg-player-ir-test-{}.wav",
            std::process::id()
        ));
        write_ir_wav(&path, &[i16::MAX]);

        let mut processor = DspProcessor::new();
        let mut samples = vec![0.25, 0.0, 0.0, 0.0];
        processor
            .process(
                &mut samples,
                &AudioFormat {
                    sample_rate: 48_000,
                    channels: 1,
                },
                &DspSettings {
                    impulse_response: Some(ImpulseResponseSettings {
                        path: path.to_string_lossy().to_string(),
                        mix: 0.5,
                    }),
                    ..DspSettings::default()
                },
            )
            .expect("IR should process");

        assert!(samples[0] > 0.5);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn missing_ir_file_reports_a_clear_error() {
        let mut processor = DspProcessor::new();
        let mut samples = vec![0.0; 1024];
        let err = processor
            .process(
                &mut samples,
                &AudioFormat {
                    sample_rate: 48_000,
                    channels: 2,
                },
                &DspSettings {
                    impulse_response: Some(ImpulseResponseSettings {
                        path: "/definitely/missing/ir.wav".to_string(),
                        mix: 0.4,
                    }),
                    ..DspSettings::default()
                },
            )
            .expect_err("missing IR should fail");

        assert!(err.to_string().contains("impulse response file not found"));
    }

    fn write_ir_wav(path: &std::path::Path, samples: &[i16]) {
        let sample_rate = 48_000u32;
        let channels = 1u16;
        let bits_per_sample = 16u16;
        let byte_rate = sample_rate * u32::from(channels) * u32::from(bits_per_sample) / 8;
        let block_align = channels * bits_per_sample / 8;
        let data_size = samples.len() as u32 * u32::from(block_align);

        let mut file = fs::File::create(path).expect("temp wav should be writable");
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_size).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&channels.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&byte_rate.to_le_bytes()).unwrap();
        file.write_all(&block_align.to_le_bytes()).unwrap();
        file.write_all(&bits_per_sample.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_size.to_le_bytes()).unwrap();
        for sample in samples {
            file.write_all(&sample.to_le_bytes()).unwrap();
        }
    }
}
