use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use std::sync::Arc;

const SEGMENT_SIZE: usize = 4096;
const FFT_SIZE: usize = SEGMENT_SIZE * 2;
const LEVEL_COUNT: usize = 5;
const CHANNEL_COUNT: usize = 2;
// Fixed layout: [sample rate: 44.1k/48k][level: 0..4][channel: L/R][4096 f32-le].
// The shorter level-1 responses are zero-padded so selection never needs a variable offset.
const KERNEL_BYTES: &[u8; 327_680] = include_bytes!("vhe_kernels.bin");

pub(crate) struct VheProcessor {
    convolvers: Option<[VheConvolver; CHANNEL_COUNT]>,
}

impl VheProcessor {
    pub(crate) fn new(sample_rate: u32, level: i32) -> Self {
        let rate_index = match sample_rate {
            44_100 => Some(0),
            48_000 => Some(1),
            _ => None,
        };
        let level = usize::try_from(level)
            .ok()
            .filter(|level| *level < LEVEL_COUNT);
        let convolvers = rate_index.zip(level).map(|(rate_index, level)| {
            std::array::from_fn(|channel| {
                VheConvolver::new(load_kernel(rate_index, level, channel))
            })
        });
        Self { convolvers }
    }

    pub(crate) fn process(&mut self, samples: &mut [f32]) {
        let Some(convolvers) = &mut self.convolvers else {
            return;
        };
        for (channel, convolver) in convolvers.iter_mut().enumerate() {
            convolver.process_interleaved(samples, channel);
        }
    }
}

fn load_kernel(rate_index: usize, level: usize, channel: usize) -> Vec<f32> {
    let first = ((rate_index * LEVEL_COUNT + level) * CHANNEL_COUNT + channel) * SEGMENT_SIZE;
    (0..SEGMENT_SIZE)
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

struct VheConvolver {
    forward: Arc<dyn Fft<f32>>,
    inverse: Arc<dyn Fft<f32>>,
    kernel_spectrum: Vec<Complex32>,
    transform: Vec<Complex32>,
    previous: Vec<f32>,
    current: Vec<f32>,
    input_fill: usize,
}

impl VheConvolver {
    fn new(kernel: Vec<f32>) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let forward = planner.plan_fft_forward(FFT_SIZE);
        let inverse = planner.plan_fft_inverse(FFT_SIZE);
        let mut kernel_spectrum = vec![Complex32::ZERO; FFT_SIZE];
        for (target, sample) in kernel_spectrum.iter_mut().zip(kernel) {
            target.re = sample;
        }
        forward.process(&mut kernel_spectrum);
        Self {
            forward,
            inverse,
            kernel_spectrum,
            transform: vec![Complex32::ZERO; FFT_SIZE],
            previous: vec![0.0; SEGMENT_SIZE],
            current: vec![0.0; SEGMENT_SIZE],
            input_fill: 0,
        }
    }

    fn process_interleaved(&mut self, samples: &mut [f32], channel: usize) {
        let frames = samples.len() / CHANNEL_COUNT;
        let mut offset = 0;
        while offset < frames {
            let count = (frames - offset).min(SEGMENT_SIZE - self.input_fill);
            for index in 0..count {
                self.current[self.input_fill + index] =
                    samples[(offset + index) * CHANNEL_COUNT + channel];
            }

            // Rebuild the active overlap-save window so the current host block can be emitted
            // immediately, including when calls do not align to the 4096-frame segment size.
            self.transform.fill(Complex32::ZERO);
            for (target, sample) in self.transform.iter_mut().zip(self.previous.iter().copied()) {
                target.re = sample;
            }
            for (target, sample) in self.transform[SEGMENT_SIZE..]
                .iter_mut()
                .zip(self.current[..self.input_fill + count].iter().copied())
            {
                target.re = sample;
            }
            self.forward.process(&mut self.transform);
            for (sample, kernel) in self.transform.iter_mut().zip(&self.kernel_spectrum) {
                *sample *= *kernel;
            }
            self.inverse.process(&mut self.transform);

            let scale = 1.0 / FFT_SIZE as f32;
            for index in 0..count {
                samples[(offset + index) * CHANNEL_COUNT + channel] =
                    self.transform[SEGMENT_SIZE + self.input_fill + index].re * scale;
            }

            self.input_fill += count;
            if self.input_fill == SEGMENT_SIZE {
                self.previous.copy_from_slice(&self.current);
                self.current.fill(0.0);
                self.input_fill = 0;
            }
            offset += count;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_sample_rate_is_passthrough() {
        let mut processor = VheProcessor::new(96_000, 2);
        let mut samples = vec![0.25, -0.5, 0.1, 0.2];
        processor.process(&mut samples);
        assert_eq!(samples, [0.25, -0.5, 0.1, 0.2]);
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
            let mut processor = VheProcessor::new(48_000, level as i32);
            for block in samples.chunks_exact_mut(512) {
                processor.process(block);
            }

            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[frame * 2 + channel] - EXPECTED[level][position][channel]).abs()
                            <= 2.0e-5,
                        "level {level}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[level][position][channel],
                        samples[frame * 2 + channel]
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
            let mut processor = VheProcessor::new(44_100, level as i32);
            processor.process(&mut samples);
            for (position, frame) in SELECTED.iter().copied().enumerate() {
                for channel in 0..2 {
                    assert!(
                        (samples[frame * 2 + channel] - EXPECTED[level][position][channel]).abs()
                            <= 2.0e-5,
                        "level {level}, frame {frame}, channel {channel}: expected {}, got {}",
                        EXPECTED[level][position][channel],
                        samples[frame * 2 + channel]
                    );
                }
            }
        }
    }
}
