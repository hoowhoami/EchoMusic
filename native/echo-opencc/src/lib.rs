use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use once_cell::sync::Lazy;
use opencc_fmmseg::OpenCC;

static CONVERTER: Lazy<OpenCC> = Lazy::new(|| {
    let mut converter = OpenCC::new();
    // Lyric lines are short; the N-API worker already keeps conversion off the
    // event loop, without creating an additional Rayon pool for every process.
    converter.set_parallel(false);
    converter
});

fn normalize_profile(profile: &str) -> napi::Result<&'static str> {
    match profile {
        "s2t" => Ok("s2t"),
        "t2s" => Ok("t2s"),
        "s2tw" => Ok("s2tw"),
        "s2hk" => Ok("s2hk"),
        other => Err(napi::Error::from_reason(format!(
            "unsupported OpenCC profile: {other}"
        ))),
    }
}

#[napi(js_name = "convert")]
pub fn convert(text: String, profile: String) -> napi::Result<String> {
    let profile = normalize_profile(&profile)?;
    Ok(CONVERTER.convert(&text, profile, false))
}

pub struct ConvertBatchTask {
    texts: Vec<String>,
    profile: &'static str,
}

impl Task for ConvertBatchTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(self
            .texts
            .iter()
            .map(|text| CONVERTER.convert(text, self.profile, false))
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(js_name = "convertBatch")]
pub fn convert_batch(
    texts: Vec<String>,
    profile: String,
) -> napi::Result<AsyncTask<ConvertBatchTask>> {
    Ok(AsyncTask::new(ConvertBatchTask {
        texts,
        profile: normalize_profile(&profile)?,
    }))
}
