use soundtouch_rs::{SoundTouch, SpectralStretch};
use wasm_bindgen::prelude::*;

const OUTPUT_CHUNK_SIZE: usize = 128;
const INPUT_CHUNK_DURATION_RATIO: f64 = 0.04266;

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StretchAlgorithm {
    Wsola = 0,
    #[default]
    Spectral = 1,
}

enum StretchEngine {
    Wsola(SoundTouch),
    Spectral(SpectralStretch),
}

#[wasm_bindgen]
pub struct SoundTouchProcessor {
    engine: StretchEngine,
    algorithm: StretchAlgorithm,
    channels: usize,
    sample_rate: usize,
    input_chunk_size: usize,

    tempo: f64,
    pitch: f64,
    rate: f64,

    formant_factor: f64,
    formant_compensate_pitch: bool,

    input_buffers: Vec<Vec<f32>>,
    output_buffers: Vec<Vec<f32>>,
}

impl SoundTouchProcessor {
    fn create_engine(
        algorithm: StretchAlgorithm,
        channels: usize,
        sample_rate: usize,
    ) -> Result<StretchEngine, JsValue> {
        match algorithm {
            StretchAlgorithm::Wsola => {
                let st = SoundTouch::builder(channels, sample_rate)
                    .build()
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                Ok(StretchEngine::Wsola(st))
            }
            StretchAlgorithm::Spectral => {
                let st = SpectralStretch::builder(channels, sample_rate)
                    .build()
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
                Ok(StretchEngine::Spectral(st))
            }
        }
    }

    fn apply_parameters(&mut self) {
        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                st.set_tempo(self.tempo);
                st.set_pitch(self.pitch);
                st.set_rate(self.rate);
            }
            StretchEngine::Spectral(st) => {
                st.set_tempo(self.tempo * self.rate);
                st.set_pitch(self.pitch * self.rate);
                st.set_formant_factor(self.formant_factor, self.formant_compensate_pitch);
            }
        }
    }
}

#[wasm_bindgen]
impl SoundTouchProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(
        channels: usize,
        sample_rate: usize,
        algorithm: Option<StretchAlgorithm>,
    ) -> Result<SoundTouchProcessor, JsValue> {
        let algo = algorithm.unwrap_or(StretchAlgorithm::Spectral);
        let engine = Self::create_engine(algo, channels, sample_rate)?;

        let input_chunk_size = (sample_rate as f64 * INPUT_CHUNK_DURATION_RATIO).ceil() as usize;
        let input_buffers = vec![vec![0.0; input_chunk_size]; channels];
        let output_buffers = vec![vec![0.0; OUTPUT_CHUNK_SIZE]; channels];

        Ok(Self {
            engine,
            algorithm: algo,
            channels,
            sample_rate,
            input_chunk_size,
            tempo: 1.0,
            pitch: 1.0,
            rate: 1.0,
            formant_factor: 1.0,
            formant_compensate_pitch: false,
            input_buffers,
            output_buffers,
        })
    }

    #[wasm_bindgen(js_name = setAlgorithm)]
    pub fn set_algorithm(&mut self, algorithm: StretchAlgorithm) -> Result<(), JsValue> {
        if self.algorithm == algorithm {
            return Ok(());
        }
        self.engine = Self::create_engine(algorithm, self.channels, self.sample_rate)?;
        self.algorithm = algorithm;
        self.apply_parameters();
        self.clear();
        Ok(())
    }

    #[wasm_bindgen(js_name = getAlgorithm)]
    pub fn get_algorithm(&self) -> StretchAlgorithm {
        self.algorithm
    }

    #[wasm_bindgen(js_name = setFormantFactor)]
    pub fn set_formant_factor(&mut self, factor: f64, compensate_pitch: bool) {
        self.formant_factor = factor;
        self.formant_compensate_pitch = compensate_pitch;
        if let StretchEngine::Spectral(st) = &mut self.engine {
            st.set_formant_factor(factor, compensate_pitch);
        }
    }

    #[wasm_bindgen(js_name = getInputChunkSize)]
    pub fn get_input_chunk_size(&self) -> usize {
        self.input_chunk_size
    }

    #[wasm_bindgen(js_name = getInputPtr)]
    pub fn get_input_ptr(&mut self, channel: usize) -> *mut f32 {
        if channel < self.channels {
            self.input_buffers[channel].as_mut_ptr()
        } else {
            std::ptr::null_mut()
        }
    }

    #[wasm_bindgen(js_name = getOutputPtr)]
    pub fn get_output_ptr(&self, channel: usize) -> *const f32 {
        if channel < self.channels {
            self.output_buffers[channel].as_ptr()
        } else {
            std::ptr::null()
        }
    }

    #[wasm_bindgen(js_name = processInput)]
    pub fn process_input(&mut self, num_samples: usize) -> Result<(), JsValue> {
        if num_samples == 0 {
            return Ok(());
        }

        let valid_samples = num_samples.min(self.input_chunk_size);

        let input_slices: Vec<&[f32]> = self
            .input_buffers
            .iter()
            .map(|channel_buf| &channel_buf[..valid_samples])
            .collect();

        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                st.put_samples(&input_slices)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
            StretchEngine::Spectral(st) => {
                st.put_samples(&input_slices)
                    .map_err(|e| JsValue::from_str(&e.to_string()))?;
            }
        }
        Ok(())
    }

    #[wasm_bindgen(js_name = extractOutput)]
    pub fn extract_output(&mut self, max_samples: usize) -> Result<usize, JsValue> {
        let limit = max_samples.min(OUTPUT_CHUNK_SIZE);
        if limit == 0 {
            return Ok(0);
        }

        let mut output_slices: Vec<&mut [f32]> = self
            .output_buffers
            .iter_mut()
            .map(|channel_buf| &mut channel_buf[..limit])
            .collect();

        let received = match &mut self.engine {
            StretchEngine::Wsola(st) => st
                .receive_samples(&mut output_slices)
                .map_err(|e| JsValue::from_str(&e.to_string()))?,
            StretchEngine::Spectral(st) => st
                .receive_samples(&mut output_slices)
                .map_err(|e| JsValue::from_str(&e.to_string()))?,
        };
        Ok(received)
    }

    #[wasm_bindgen(js_name = numSamples)]
    pub fn num_samples(&self) -> usize {
        match &self.engine {
            StretchEngine::Wsola(st) => st.num_samples(),
            StretchEngine::Spectral(st) => st.num_samples(),
        }
    }

    #[wasm_bindgen]
    pub fn clear(&mut self) {
        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                let _ = st.clear();
            }
            StretchEngine::Spectral(st) => {
                let _ = st.clear();
            }
        }
    }

    #[wasm_bindgen(js_name = setTempo)]
    pub fn set_tempo(&mut self, tempo: f64) {
        self.tempo = tempo;
        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                st.set_tempo(tempo);
            }
            StretchEngine::Spectral(st) => {
                st.set_tempo(tempo * self.rate);
            }
        }
    }

    #[wasm_bindgen(js_name = setPitch)]
    pub fn set_pitch(&mut self, pitch: f64) {
        self.pitch = pitch;
        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                st.set_pitch(pitch);
            }
            StretchEngine::Spectral(st) => {
                st.set_pitch(pitch * self.rate);
            }
        }
    }

    #[wasm_bindgen(js_name = setRate)]
    pub fn set_rate(&mut self, rate: f64) {
        self.rate = rate;
        match &mut self.engine {
            StretchEngine::Wsola(st) => {
                st.set_rate(rate);
            }
            StretchEngine::Spectral(st) => {
                st.set_tempo(self.tempo * rate);
                st.set_pitch(self.pitch * rate);
            }
        }
    }
}
