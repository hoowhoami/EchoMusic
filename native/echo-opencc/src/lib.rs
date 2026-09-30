use napi_derive::napi;
use once_cell::sync::Lazy;
use opencc_fmmseg::OpenCC;

static CONVERTER: Lazy<OpenCC> = Lazy::new(OpenCC::new);

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

#[napi(js_name = "convertBatch")]
pub fn convert_batch(texts: Vec<String>, profile: String) -> napi::Result<Vec<String>> {
    let profile = normalize_profile(&profile)?;
    Ok(texts
        .into_iter()
        .map(|text| CONVERTER.convert(&text, profile, false))
        .collect())
}

