use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use once_cell::sync::Lazy;
use opencc_fmmseg::{CustomDictMode, CustomDictSpec, DictSlot, DictionaryMaxlength, OpenCC};

/// 解析内置词典。
/// 返回 Result 而不是 panic：词典是随包资源，若被后续编辑破坏，
/// 应在调用处得到可读错误，而不是让 napi 线程在生产调用中 panic。
fn dictionary_pairs(data: &str) -> Result<Vec<(String, String)>, String> {
    data.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(|line| {
            let (source, targets) = line
                .split_once('\t')
                .ok_or_else(|| format!("invalid bundled OpenCC entry: {line:?}"))?;
            let target = targets
                .split_whitespace()
                .next()
                .ok_or_else(|| format!("empty OpenCC target: {line:?}"))?;
            if source.chars().count() != target.chars().count() {
                return Err(format!(
                    "bundled OpenCC entry has mismatched character counts: {line:?}"
                ));
            }
            Ok((source.to_owned(), target.to_owned()))
        })
        .collect()
}

static CONVERTER: Lazy<Result<OpenCC, String>> = Lazy::new(|| {
    // Replace only the reverse-variant slots, unused by the existing four profiles.
    // Keep upstream phrase exceptions rather than doing blanket char replacements.
    let tw_variants = dictionary_pairs(include_str!("../dicts/TWVariantsRev.txt"))
        .map_err(|error| format!("invalid bundled OpenCC dictionaries: {error}"))?;
    let tw_variants_phrases = dictionary_pairs(include_str!("../dicts/TWVariantsRevPhrases.txt"))
        .map_err(|error| format!("invalid bundled OpenCC dictionaries: {error}"))?;
    let dictionary = DictionaryMaxlength::from_zstd()
        .and_then(|dictionary| {
            dictionary.with_custom_dicts(&[
                CustomDictSpec {
                    slot: DictSlot::TWVariantsRev,
                    pairs: tw_variants,
                    mode: CustomDictMode::Override,
                },
                CustomDictSpec {
                    slot: DictSlot::TWVariantsRevPhrases,
                    pairs: tw_variants_phrases,
                    mode: CustomDictMode::Override,
                },
            ])
        })
        .map_err(|error| format!("invalid bundled OpenCC dictionaries: {error:?}"))?;
    let mut converter = OpenCC::from_dictionary(dictionary);
    // Lyric lines are short; the N-API worker already keeps conversion off the
    // event loop, without creating an additional Rayon pool for every process.
    converter.set_parallel(false);
    Ok(converter)
});

fn converter() -> napi::Result<&'static OpenCC> {
    match &*CONVERTER {
        Ok(converter) => Ok(converter),
        Err(message) => Err(napi::Error::from_reason(message.clone())),
    }
}

fn normalize_profile(profile: &str) -> napi::Result<&'static str> {
    match profile {
        "s2t" => Ok("s2t"),
        "s2t-variants" => Ok("s2t-variants"),
        "t2s" => Ok("t2s"),
        "s2tw" => Ok("s2tw"),
        "s2hk" => Ok("s2hk"),
        other => Err(napi::Error::from_reason(format!(
            "unsupported OpenCC profile: {other}"
        ))),
    }
}

fn convert_text(text: &str, profile: &str) -> napi::Result<String> {
    let converter = converter()?;
    Ok(if profile == "s2t-variants" {
        converter.tw2t(&converter.s2t(text, false), false)
    } else {
        converter.convert(text, profile, false)
    })
}

#[napi(js_name = "convert")]
pub fn convert(text: String, profile: String) -> napi::Result<String> {
    let profile = normalize_profile(&profile)?;
    convert_text(&text, profile)
}

pub struct ConvertBatchTask {
    texts: Vec<String>,
    profile: &'static str,
}

impl Task for ConvertBatchTask {
    type Output = Vec<String>;
    type JsValue = Vec<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        self.texts
            .iter()
            .map(|text| convert_text(text, self.profile))
            .collect()
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
