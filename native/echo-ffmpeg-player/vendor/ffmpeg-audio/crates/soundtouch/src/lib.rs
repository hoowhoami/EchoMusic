use soundtouch_rs::SoundTouch;
use wasm_bindgen::prelude::*;

const OUTPUT_CHUNK_SIZE: usize = 128;
const INPUT_CHUNK_DURATION_RATIO: f64 = 0.04266;

#[wasm_bindgen]
pub struct SoundTouchProcessor {
    st: SoundTouch,
    channels: usize,
    input_chunk_size: usize,

    input_buffers: Vec<Vec<f32>>,
    output_buffers: Vec<Vec<f32>>,
}

#[wasm_bindgen]
impl SoundTouchProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new(channels: usize, sample_rate: usize) -> Result<SoundTouchProcessor, JsValue> {
        let st = SoundTouch::builder(channels, sample_rate)
            .build()
            .map_err(|e| JsValue::from_str(&e.to_string()))?;

        let input_chunk_size = (sample_rate as f64 * INPUT_CHUNK_DURATION_RATIO).ceil() as usize;
        let input_buffers = vec![vec![0.0; input_chunk_size]; channels];
        let output_buffers = vec![vec![0.0; OUTPUT_CHUNK_SIZE]; channels];

        Ok(Self {
            st,
            channels,
            input_chunk_size,
            input_buffers,
            output_buffers,
        })
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
        self.st
            .put_samples(&input_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
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
        let received = self
            .st
            .receive_samples(&mut output_slices)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(received)
    }

    #[wasm_bindgen(js_name = numSamples)]
    pub fn num_samples(&self) -> usize {
        self.st.num_samples()
    }

    #[wasm_bindgen]
    pub fn clear(&mut self) {
        let _ = self.st.clear();
    }

    #[wasm_bindgen(js_name = setTempo)]
    pub fn set_tempo(&mut self, tempo: f64) {
        self.st.set_tempo(tempo);
    }

    #[wasm_bindgen(js_name = setPitch)]
    pub fn set_pitch(&mut self, pitch: f64) {
        self.st.set_pitch(pitch);
    }

    #[wasm_bindgen(js_name = setRate)]
    pub fn set_rate(&mut self, rate: f64) {
        self.st.set_rate(rate);
    }
}
