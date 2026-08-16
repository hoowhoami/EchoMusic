use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::collections::VecDeque;
use std::sync::Arc;

const KERNEL_TAPS: usize = 4096;
const LEVEL_COUNT: usize = 5;
const CHANNEL_COUNT: usize = 2;
const REFERENCE_SAMPLE_RATES: [u32; 2] = [44_100, 48_000];
const SAMPLE_RATE_FAMILY_STEP: u32 = 11_025;
const EARLY_BLOCK_SIZE: usize = 256;
const EARLY_TAPS: usize = 1024;
const LATE_BLOCK_SIZE: usize = 1024;
const VHE_LATENCY_FRAMES: usize = EARLY_BLOCK_SIZE - 1;
const IR_TRIM_THRESHOLD: f32 = 0.00003;
// A 32-sample Hann-windowed sinc is a deliberate quality/initialization-cost trade-off. Even
// for the supported 48 -> 8 kHz extreme downsample it spans several transition-band lobes.
const SINC_RADIUS: isize = 32;
// Fixed layout: [sample rate: 44.1k/48k][level: 0..4][channel: L/R][4096 f32-le].
// The shorter level-1 responses are zero-padded so selection never needs a variable offset. At
// other playback rates the selected reference response is resampled once when the VPF is loaded.
const KERNEL_BYTES: &[u8; 327_680] = include_bytes!("vhe_kernels.bin");

pub(crate) struct VheProcessor {
    convolvers: Option<[VheConvolver; CHANNEL_COUNT]>,
}

impl VheProcessor {
    pub(crate) fn new(sample_rate: u32, level: i32) -> Self {
        debug_assert!((0..LEVEL_COUNT as i32).contains(&level));
        let sample_rate = sample_rate.max(8_000);
        let rate_index = reference_rate_index(sample_rate);
        let level = usize::try_from(level)
            .ok()
            .filter(|level| *level < LEVEL_COUNT);
        let convolvers = level.map(|level| {
            std::array::from_fn(|channel| {
                let kernel = load_kernel(rate_index, level, channel);
                let reference_rate = REFERENCE_SAMPLE_RATES[rate_index];
                let kernel = if sample_rate == reference_rate {
                    kernel
                } else {
                    resample_impulse_response(&kernel, reference_rate, sample_rate)
                };
                VheConvolver::new(kernel)
            })
        });
        Self { convolvers }
    }

    pub(crate) fn process(&mut self, samples: &mut [f32]) {
        // A trailing partial stereo frame would leave its final sample unconvolved. Bypass the
        // whole malformed buffer so it cannot contain a mixture of processed and raw samples.
        if !samples.chunks_exact(CHANNEL_COUNT).remainder().is_empty() {
            return;
        }
        let Some(convolvers) = &mut self.convolvers else {
            return;
        };
        for (channel, convolver) in convolvers.iter_mut().enumerate() {
            convolver.process_interleaved(samples, channel);
        }
    }

    pub(crate) fn latency_frames(&self) -> usize {
        self.convolvers
            .as_ref()
            .map(|convolvers| convolvers[0].latency_frames())
            .unwrap_or_default()
    }
}

fn reference_rate_index(sample_rate: u32) -> usize {
    // Preserve the native 44.1 kHz family for its integer multiples/divisors. Device-oriented
    // rates such as 8/16/24/32/48/96/192 kHz use the 48 kHz reference response.
    usize::from(!sample_rate.is_multiple_of(SAMPLE_RATE_FAMILY_STEP))
}

fn load_kernel(rate_index: usize, level: usize, channel: usize) -> Vec<f32> {
    let first = ((rate_index * LEVEL_COUNT + level) * CHANNEL_COUNT + channel) * KERNEL_TAPS;
    (0..KERNEL_TAPS)
        .map(|index| {
            let byte_index = (first + index) * 4;
            f32::from_le_bytes(
                KERNEL_BYTES[byte_index..byte_index + 4]
                    .try_into()
                    .expect("VHE kernel has a fixed layout"),
            )
        })
        .collect()
}

fn resample_impulse_response(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == 0 || target_rate == 0 {
        return Vec::new();
    }
    if source_rate == target_rate {
        return input.to_vec();
    }

    let output_len =
        ((input.len() as u64 * u64::from(target_rate)).div_ceil(u64::from(source_rate))) as usize;
    let ratio = f64::from(target_rate) / f64::from(source_rate);
    let cutoff = ratio.min(1.0);
    let impulse_gain_correction = 1.0 / ratio;
    let mut output = Vec::with_capacity(output_len);

    for output_index in 0..output_len {
        let source_position = output_index as f64 / ratio;
        let center = source_position.floor() as isize;
        let mut value = 0.0_f64;
        for input_index in center - SINC_RADIUS + 1..=center + SINC_RADIUS {
            let Ok(input_index_usize) = usize::try_from(input_index) else {
                continue;
            };
            let Some(sample) = input.get(input_index_usize) else {
                continue;
            };
            let distance = source_position - input_index as f64;
            if distance.abs() >= SINC_RADIUS as f64 {
                continue;
            }
            let sinc_position = cutoff * distance;
            let sinc = if sinc_position.abs() <= f64::EPSILON {
                1.0
            } else {
                (std::f64::consts::PI * sinc_position).sin()
                    / (std::f64::consts::PI * sinc_position)
            };
            let window = 0.5 + 0.5 * (std::f64::consts::PI * distance / SINC_RADIUS as f64).cos();
            value += f64::from(*sample) * cutoff * sinc * window;
        }
        output.push((value * impulse_gain_correction) as f32);
    }

    let last_active = output
        .iter()
        .rposition(|sample| sample.abs() >= IR_TRIM_THRESHOLD)
        .unwrap_or_default();
    output.truncate((last_active + 1).max(1));
    output
}

// Non-uniform partitioning keeps the first response taps at low latency and moves the long tail
// to larger, cheaper blocks. FFT work happens only when a block is complete, so host callback
// slicing cannot multiply the amount of frequency-domain work.
struct VheConvolver {
    segments: Vec<VheSegmentConvolver>,
    latency_frames: usize,
}

impl VheConvolver {
    fn new(kernel: Vec<f32>) -> Self {
        let mut segments = Vec::new();
        let early_len = kernel.len().min(EARLY_TAPS);
        if early_len > 0 {
            segments.push(VheSegmentConvolver::new(
                &kernel[..early_len],
                0,
                EARLY_BLOCK_SIZE,
            ));
        }
        if kernel.len() > early_len {
            segments.push(VheSegmentConvolver::new(
                &kernel[early_len..],
                early_len,
                LATE_BLOCK_SIZE,
            ));
        }
        Self {
            latency_frames: if segments.is_empty() {
                0
            } else {
                VHE_LATENCY_FRAMES
            },
            segments,
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32], channel: usize) {
        if self.segments.is_empty() {
            return;
        }
        for frame in samples.chunks_exact_mut(CHANNEL_COUNT) {
            let input = frame[channel];
            frame[channel] = self
                .segments
                .iter_mut()
                .map(|segment| segment.process_sample(input))
                .sum();
        }
    }

    fn latency_frames(&self) -> usize {
        self.latency_frames
    }

    #[cfg(test)]
    fn processed_blocks(&self) -> usize {
        self.segments
            .iter()
            .map(|segment| segment.processed_blocks)
            .sum()
    }
}

struct VheSegmentConvolver {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    kernel_spectra: Vec<Vec<Complex32>>,
    input_spectra: Vec<Vec<Complex32>>,
    input_fft: Vec<Complex32>,
    input_block: Vec<f32>,
    overlap: Vec<f32>,
    scratch: Vec<Complex32>,
    output: VecDeque<f32>,
    block_size: usize,
    write_pos: usize,
    #[cfg(test)]
    processed_blocks: usize,
}

impl VheSegmentConvolver {
    fn new(kernel: &[f32], impulse_offset: usize, block_size: usize) -> Self {
        let fft_size = block_size * 2;
        let mut planner = FftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(fft_size);
        let inverse = planner.plan_fft_inverse(fft_size);
        let kernel_spectra = kernel
            .chunks(block_size)
            .map(|chunk| {
                let mut spectrum = vec![Complex32::ZERO; fft_size];
                for (target, sample) in spectrum.iter_mut().zip(chunk.iter().copied()) {
                    target.re = sample;
                }
                forward.process(&mut spectrum);
                spectrum
            })
            .collect::<Vec<_>>();
        let partition_count = kernel_spectra.len().max(1);
        Self {
            forward,
            inverse,
            kernel_spectra,
            input_spectra: vec![vec![Complex32::ZERO; fft_size]; partition_count],
            input_fft: vec![Complex32::ZERO; fft_size],
            input_block: Vec::with_capacity(block_size),
            overlap: vec![0.0; block_size],
            scratch: vec![Complex32::ZERO; fft_size],
            output: VecDeque::from(vec![0.0; impulse_offset + VHE_LATENCY_FRAMES]),
            block_size,
            write_pos: 0,
            #[cfg(test)]
            processed_blocks: 0,
        }
    }

    fn process_sample(&mut self, sample: f32) -> f32 {
        self.input_block.push(sample);
        if self.input_block.len() == self.block_size {
            self.process_block();
            self.input_block.clear();
        }
        self.output.pop_front().unwrap_or(0.0)
    }

    fn process_block(&mut self) {
        let fft_size = self.block_size * 2;
        self.input_fft.fill(Complex32::ZERO);
        for (target, sample) in self
            .input_fft
            .iter_mut()
            .zip(self.input_block.iter().copied())
        {
            target.re = sample;
        }
        self.forward.process(&mut self.input_fft);
        std::mem::swap(&mut self.input_spectra[self.write_pos], &mut self.input_fft);

        self.scratch.fill(Complex32::ZERO);
        for (partition_index, kernel) in self.kernel_spectra.iter().enumerate() {
            let input_index = (self.write_pos + self.input_spectra.len() - partition_index)
                % self.input_spectra.len();
            for ((accumulator, input), impulse) in self
                .scratch
                .iter_mut()
                .zip(self.input_spectra[input_index].iter())
                .zip(kernel.iter())
            {
                *accumulator += *input * *impulse;
            }
        }
        self.inverse.process(&mut self.scratch);

        let scale = 1.0 / fft_size as f32;
        for index in 0..self.block_size {
            self.output
                .push_back(self.scratch[index].re * scale + self.overlap[index]);
            self.overlap[index] = self.scratch[index + self.block_size].re * scale;
        }
        self.write_pos = (self.write_pos + 1) % self.input_spectra.len();
        #[cfg(test)]
        {
            self.processed_blocks += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_native_sample_rates_are_processed() {
        for sample_rate in [8_000, 22_050, 32_000, 88_200, 96_000, 176_400, 192_000] {
            let mut processor = VheProcessor::new(sample_rate, 2);
            let mut samples = vec![0.0; 1024];
            samples[0] = 0.8;
            samples[1] = -0.35;
            let original = samples.clone();
            processor.process(&mut samples);
            assert!(samples.iter().all(|sample| sample.is_finite()));
            assert_ne!(
                samples, original,
                "VHE unexpectedly passed through {sample_rate} Hz"
            );
            assert!(samples.iter().any(|sample| sample.abs() > 1.0e-6));
        }
    }

    #[test]
    fn malformed_stereo_buffer_is_bypassed() {
        let mut processor = VheProcessor::new(48_000, 2);
        let mut samples = vec![0.25, -0.5, 0.75];
        let original = samples.clone();

        processor.process(&mut samples);

        assert_eq!(samples, original);
    }

    #[test]
    fn empty_kernel_is_zero_latency_passthrough() {
        let mut convolver = VheConvolver::new(Vec::new());
        let mut samples = vec![0.25, -0.5, 0.75, -1.0];
        let original = samples.clone();

        convolver.process_interleaved(&mut samples, 0);

        assert_eq!(convolver.latency_frames(), 0);
        assert_eq!(samples, original);
    }

    #[test]
    fn reference_rate_selection_keeps_sample_rate_families() {
        for sample_rate in [11_025, 22_050, 44_100, 88_200, 176_400] {
            assert_eq!(reference_rate_index(sample_rate), 0);
        }
        for sample_rate in [8_000, 16_000, 24_000, 32_000, 48_000, 96_000, 192_000] {
            assert_eq!(reference_rate_index(sample_rate), 1);
        }
    }

    #[test]
    fn impulse_resampling_preserves_transfer_gain() {
        let mut impulse = vec![0.0; 256];
        impulse[64] = 1.0;
        for target_rate in [22_050, 32_000, 88_200, 96_000, 192_000] {
            let resampled = resample_impulse_response(&impulse, 48_000, target_rate);
            let gain = resampled.iter().sum::<f32>();
            assert!(
                (gain - 1.0).abs() <= 0.015,
                "transfer gain changed at {target_rate} Hz: {gain}"
            );
        }
    }

    #[test]
    fn tiered_convolver_matches_direct_convolution_with_reported_delay() {
        let kernel = (0..KERNEL_TAPS + 907)
            .map(|index| {
                let time = index as f32;
                0.002 * (-time / 1600.0).exp() * (time * 0.037).cos()
            })
            .collect::<Vec<_>>();
        let input = (0..5300)
            .map(|index| ((index * 29 % 113) as f32 - 56.0) / 80.0)
            .collect::<Vec<_>>();
        let mut interleaved = input
            .iter()
            .flat_map(|sample| [*sample, 0.0])
            .collect::<Vec<_>>();
        interleaved.resize(interleaved.len() + VHE_LATENCY_FRAMES * CHANNEL_COUNT, 0.0);
        let mut convolver = VheConvolver::new(kernel.clone());
        assert_eq!(convolver.latency_frames(), VHE_LATENCY_FRAMES);
        let block_sizes = [17, 63, 128, 251, 41];
        let mut frame = 0;
        let mut block_index = 0;
        let output_frames = interleaved.len() / CHANNEL_COUNT;
        while frame < output_frames {
            let count = block_sizes[block_index % block_sizes.len()].min(output_frames - frame);
            convolver.process_interleaved(
                &mut interleaved[frame * CHANNEL_COUNT..(frame + count) * CHANNEL_COUNT],
                0,
            );
            frame += count;
            block_index += 1;
        }

        for frame in [0_usize, 17, 699, 4095, 4096, 4097, 4500, 5299] {
            let first_input = frame.saturating_sub(kernel.len() - 1);
            let expected = (first_input..=frame)
                .map(|input_index| input[input_index] * kernel[frame - input_index])
                .sum::<f32>();
            let actual = interleaved[(frame + VHE_LATENCY_FRAMES) * CHANNEL_COUNT];
            assert!(
                (actual - expected).abs() <= 2.0e-5,
                "partitioned convolution mismatch at frame {frame}: expected={expected}, actual={actual}"
            );
        }
    }

    #[test]
    fn partial_callbacks_only_transform_completed_blocks() {
        let frames = 8192;
        let kernel = vec![0.25; KERNEL_TAPS * 4];
        let mut convolver = VheConvolver::new(kernel);
        let mut samples = vec![0.1; frames * CHANNEL_COUNT];

        for block in samples.chunks_mut(34) {
            convolver.process_interleaved(block, 0);
        }

        assert_eq!(
            convolver.processed_blocks(),
            frames / EARLY_BLOCK_SIZE + frames / LATE_BLOCK_SIZE
        );
    }

    #[test]
    fn resampling_trims_zero_padded_kernel_tail() {
        let kernel = load_kernel(1, 1, 0);
        let resampled = resample_impulse_response(&kernel, 48_000, 192_000);

        assert!(resampled.len() < KERNEL_TAPS * 3);
        assert!(resampled
            .last()
            .is_some_and(|sample| sample.abs() >= IR_TRIM_THRESHOLD));
    }

    #[test]
    fn resampled_real_kernels_match_direct_convolution() {
        const INPUT_FRAMES: usize = 1600;
        const SELECTED: [usize; 8] = [0, 1, 31, 255, 1023, 1024, 1279, 1599];

        for sample_rate in [96_000, 192_000] {
            let rate_index = reference_rate_index(sample_rate);
            let reference_rate = REFERENCE_SAMPLE_RATES[rate_index];
            for level in 0..LEVEL_COUNT {
                let mut input = Vec::with_capacity(INPUT_FRAMES * CHANNEL_COUNT);
                for frame in 0..INPUT_FRAMES {
                    let time = frame as f32;
                    input.push(0.31 * (time * 0.037).sin() + 0.11 * (time * 0.013).cos());
                    input.push(-0.27 * (time * 0.029).cos() + 0.09 * (time * 0.017).sin());
                }
                let mut actual = input.clone();
                actual.resize(actual.len() + VHE_LATENCY_FRAMES * CHANNEL_COUNT, 0.0);
                let mut processor = VheProcessor::new(sample_rate, level as i32);
                for block in actual.chunks_mut(514) {
                    processor.process(block);
                }

                for channel in 0..CHANNEL_COUNT {
                    let kernel = resample_impulse_response(
                        &load_kernel(rate_index, level, channel),
                        reference_rate,
                        sample_rate,
                    );
                    for frame in SELECTED {
                        let expected = (0..=frame)
                            .map(|input_frame| {
                                input[input_frame * CHANNEL_COUNT + channel]
                                    * kernel[frame - input_frame]
                            })
                            .sum::<f32>();
                        let output_frame = frame + VHE_LATENCY_FRAMES;
                        let value = actual[output_frame * CHANNEL_COUNT + channel];
                        assert!(
                            (value - expected).abs() <= 3.0e-5,
                            "{sample_rate} Hz level {level}, frame {frame}, channel {channel}: expected {expected}, got {value}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn all_levels_match_pcm_oracle() {
        const SELECTED: [usize; 14] = [0, 1, 2, 3, 7, 15, 31, 63, 127, 255, 511, 767, 1023, 1279];
        const EXPECTED: [[[f32; 2]; 14]; 5] = [
            [
                [-0.001607325, 0.000803209],
                [-0.002240289, 0.001437513],
                [-0.003184028, 0.002277288],
                [-0.004474528, 0.003372768],
                [-0.003547064, 0.005270472],
                [-0.008974142, 0.008395875],
                [-0.018545099, 0.005645934],
                [-0.026155218, -0.000880340],
                [0.144707024, -0.070676327],
                [0.078321889, -0.148650587],
                [0.221688986, 0.014655296],
                [0.162983418, 0.116574161],
                [0.154336661, 0.115312889],
                [-0.044595871, 0.036749594],
            ],
            [
                [0.000198631, -0.000086902],
                [-0.000176447, 0.000039691],
                [0.000201223, -0.000085992],
                [-0.000171017, 0.000039777],
                [-0.000160678, 0.000040717],
                [-0.000143295, 0.000045079],
                [-0.000131898, 0.000060254],
                [-0.000148653, 0.000071141],
                [-0.000015313, -0.000009149],
                [0.000189104, -0.000092007],
                [0.000196729, -0.000064648],
                [-0.000911415, 0.000308821],
                [0.753606319, -0.329856336],
                [-0.201245964, -0.143040568],
            ],
            [
                [0.418524146, -0.183089837],
                [0.095656976, -0.120836370],
                [-0.003774714, -0.082234219],
                [0.219899386, -0.162794203],
                [0.105890661, -0.088293858],
                [0.239025801, -0.136429667],
                [0.252260268, -0.021820117],
                [-0.064375371, 0.194063127],
                [0.113519549, -0.096053362],
                [-0.250098705, -0.161653042],
                [-0.061756819, -0.028575571],
                [-0.132546812, 0.163649857],
                [0.084782541, 0.161210090],
                [0.034880131, -0.087708473],
            ],
            [
                [0.471436679, -0.206244200],
                [0.106289327, -0.135485232],
                [-0.006049702, -0.091583163],
                [0.245939657, -0.182056740],
                [0.116351373, -0.096611321],
                [0.262350500, -0.148436069],
                [0.266450942, -0.016244644],
                [-0.090449676, 0.212277129],
                [0.118919536, -0.113775000],
                [-0.250980556, -0.176803172],
                [-0.092397869, -0.014756334],
                [-0.166787207, 0.185319707],
                [0.058752559, 0.173990309],
                [0.038405906, -0.072884127],
            ],
            [
                [0.327230394, -0.143158078],
                [0.076443307, -0.095210373],
                [-0.000940695, -0.065499492],
                [0.173959449, -0.128826708],
                [0.086110979, -0.072332412],
                [0.194826365, -0.112810269],
                [0.217999265, -0.027120702],
                [-0.027604513, 0.158668488],
                [0.107924595, -0.069474347],
                [-0.145133615, -0.172353476],
                [-0.123894602, 0.024346279],
                [-0.234427482, 0.172551870],
                [0.022764068, 0.186760500],
                [0.041013896, 0.103929371],
            ],
        ];

        for level in 0..5 {
            let mut samples = Vec::with_capacity(2560);
            for frame in 0..1280 {
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
            samples.resize(samples.len() + VHE_LATENCY_FRAMES * CHANNEL_COUNT, 0.0);
            let mut processor = VheProcessor::new(48_000, level as i32);
            for block in samples.chunks_mut(512) {
                processor.process(block);
            }

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[(frame + VHE_LATENCY_FRAMES) * 2 + channel]
                            - EXPECTED[level][position][channel])
                            .abs()
                            <= 2.0e-5,
                        "level {level}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[level][position][channel],
                        samples[(frame + VHE_LATENCY_FRAMES) * 2 + channel]
                    );
                }
            }
        }
    }

    #[test]
    fn all_levels_match_44100_pcm_oracle() {
        const SELECTED: [usize; 8] = [0, 1, 3, 15, 63, 127, 255, 511];
        const EXPECTED: [[[f32; 2]; 8]; 5] = [
            [
                [-0.001607330, 0.000803212],
                [-0.002240301, 0.001437508],
                [-0.004474546, 0.003372766],
                [-0.008974154, 0.008395876],
                [-0.026155218, -0.000880345],
                [0.144707009, -0.070676327],
                [0.078321889, -0.148650587],
                [0.221688986, 0.014655296],
            ],
            [
                [0.000198631, -0.000086911],
                [-0.000176445, 0.000039687],
                [-0.000171030, 0.000039773],
                [-0.000143301, 0.000045084],
                [-0.000148647, 0.000071139],
                [-0.000015319, -0.000009139],
                [0.000189115, -0.000091997],
                [0.000196729, -0.000064648],
            ],
            [
                [0.454595178, -0.198870808],
                [0.046894051, -0.106311291],
                [0.225692615, -0.172826022],
                [0.165939450, -0.115437515],
                [-0.062998407, 0.194524944],
                [0.118782997, -0.103913307],
                [-0.253615290, -0.181400776],
                [-0.139738083, -0.035625368],
            ],
            [
                [0.508585811, -0.222496867],
                [0.050748691, -0.118197888],
                [0.250436813, -0.191846192],
                [0.177775502, -0.123153225],
                [-0.088495657, 0.210147530],
                [0.124971122, -0.120915838],
                [-0.253810465, -0.189741522],
                [-0.135888159, -0.016264766],
            ],
            [
                [0.354216337, -0.154964536],
                [0.038484380, -0.083697312],
                [0.178254336, -0.136439830],
                [0.138443321, -0.097046345],
                [-0.025708996, 0.159864664],
                [0.113183811, -0.076887026],
                [-0.177286834, -0.153892234],
                [0.036226690, 0.002793276],
            ],
        ];

        for level in 0..5 {
            let mut samples = Vec::with_capacity(1024);
            for frame in 0..512 {
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
            samples.resize(samples.len() + VHE_LATENCY_FRAMES * CHANNEL_COUNT, 0.0);
            let mut processor = VheProcessor::new(44_100, level as i32);
            processor.process(&mut samples);
            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[(frame + VHE_LATENCY_FRAMES) * 2 + channel]
                            - EXPECTED[level][position][channel])
                            .abs()
                            <= 2.0e-5,
                        "level {level}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[level][position][channel],
                        samples[(frame + VHE_LATENCY_FRAMES) * 2 + channel]
                    );
                }
            }
        }
    }
}
