use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use once_cell::sync::Lazy;
use opencc_fmmseg::{CustomDictMode, CustomDictSpec, DictSlot, DictionaryMaxlength, OpenCC};

fn dictionary_pairs(data: &str) -> Vec<(String, String)> {
    data.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(|line| {
            let (source, targets) = line.split_once('\t').expect("invalid bundled OpenCC entry");
            let target = targets
                .split_whitespace()
                .next()
                .expect("empty OpenCC target");
            assert_eq!(source.chars().count(), target.chars().count());
            (source.to_owned(), target.to_owned())
        })
        .collect()
}

static CONVERTER: Lazy<OpenCC> = Lazy::new(|| {
    // Replace only the reverse-variant slots, unused by the existing four profiles.
    // Keep upstream phrase exceptions rather than doing blanket char replacements.
    let dictionary = DictionaryMaxlength::from_zstd()
        .and_then(|dictionary| {
            dictionary.with_custom_dicts(&[
                CustomDictSpec {
                    slot: DictSlot::TWVariantsRev,
                    pairs: dictionary_pairs(include_str!("../dicts/TWVariantsRev.txt")),
                    mode: CustomDictMode::Override,
                },
                CustomDictSpec {
                    slot: DictSlot::TWVariantsRevPhrases,
                    pairs: dictionary_pairs(include_str!("../dicts/TWVariantsRevPhrases.txt")),
                    mode: CustomDictMode::Override,
                },
            ])
        })
        .expect("invalid bundled OpenCC dictionaries");
    let mut converter = OpenCC::from_dictionary(dictionary);
    // Lyric lines are short; the N-API worker already keeps conversion off the
    // event loop, without creating an additional Rayon pool for every process.
    converter.set_parallel(false);
    converter
});

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

fn convert_text(text: &str, profile: &str) -> String {
    if profile == "s2t-variants" {
        CONVERTER.tw2t(&CONVERTER.s2t(text, false), false)
    } else {
        CONVERTER.convert(text, profile, false)
    }
}

#[napi(js_name = "convert")]
pub fn convert(text: String, profile: String) -> napi::Result<String> {
    let profile = normalize_profile(&profile)?;
    Ok(convert_text(&text, profile))
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
            .map(|text| convert_text(text, self.profile))
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
