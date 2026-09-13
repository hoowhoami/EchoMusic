use super::*;
use crate::transition::analysis::{TrackAnalysis, TrackAnalyzer};
use crate::transition::decide::{decide_transition, TransitionRequest, TransitionTrigger};
use crate::transition::{TransitionMode, TransitionSettings};
use crate::transition_runner::ArmedTransition;
use napi_derive::napi;
use std::collections::HashMap;
use std::sync::Weak;

/// A prepare request cancels all of its readers, but a reader's seek/drop must not
/// cancel the request or any sibling reader.
#[derive(Default)]
pub(crate) struct PreparationCancellation {
    state: Mutex<PreparationCancellationState>,
}

#[derive(Default)]
struct PreparationCancellationState {
    cancelled: bool,
    readers: Vec<Weak<AtomicBool>>,
}

impl PreparationCancellation {
    pub(crate) fn reader_interrupt(&self) -> Arc<AtomicBool> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let interrupt = Arc::new(AtomicBool::new(state.cancelled));
        state.readers.retain(|reader| reader.strong_count() > 0);
        state.readers.push(Arc::downgrade(&interrupt));
        interrupt
    }

    pub(crate) fn cancel(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.cancelled = true;
        for reader in state.readers.iter().filter_map(Weak::upgrade) {
            reader.store(true, Ordering::Release);
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancelled
    }
}

/// Head window analysed on the incoming track for smart mixing.
const HEAD_WINDOW_SECS: f64 = 45.0;
/// Tail window analysed on the outgoing track for smart mixing.
const TAIL_WINDOW_SECS: f64 = 90.0;
/// Windows for the non-musical modes (silence detection only).
const GAPLESS_HEAD_WINDOW_SECS: f64 = 6.0;
const GAPLESS_TAIL_WINDOW_SECS: f64 = 12.0;
const ANALYSIS_CACHE_ENTRIES: usize = 12;
/// Consecutive decode errors tolerated at the start of an analysis window.
const ANALYSIS_MAX_DECODE_ERRORS: usize = 8;
/// Minimum audio an analysis window must yield to be usable at all.
const ANALYSIS_MIN_SECS: f64 = 2.0;

/// Transition settings shared between the napi surface and the prepare path.
pub(crate) static TRANSITION_SETTINGS: Mutex<TransitionSettings> = Mutex::new(TransitionSettings {
    mode: TransitionMode::AutomixPro,
    fade_secs: 5.0,
});

/// Cache of per-track analyses keyed by URL (+ audio stream ordinal).
static ANALYSIS_CACHE: Mutex<Option<AnalysisCache>> = Mutex::new(None);
/// Last decided plan, for diagnostics (`getTransitionDiagnostics`).
static LAST_PLAN_JSON: Mutex<Option<String>> = Mutex::new(None);

#[derive(Default)]
struct AnalysisCache {
    order: Vec<String>,
    entries: HashMap<String, CachedAnalysis>,
}

#[derive(Clone, Default)]
struct CachedAnalysis {
    head: Option<TrackAnalysis>,
    tail: Option<TrackAnalysis>,
}

fn cache_key(url: &str, audio_stream_ordinal: Option<usize>) -> String {
    match audio_stream_ordinal {
        Some(ordinal) => format!("{url}#{ordinal}"),
        None => url.to_string(),
    }
}

fn cache_get(key: &str) -> CachedAnalysis {
    ANALYSIS_CACHE
        .lock()
        .ok()
        .and_then(|cache| {
            cache
                .as_ref()
                .and_then(|cache| cache.entries.get(key).cloned())
        })
        .unwrap_or_default()
}

fn cache_put(key: String, update: impl FnOnce(&mut CachedAnalysis)) {
    let Ok(mut guard) = ANALYSIS_CACHE.lock() else {
        return;
    };
    let cache = guard.get_or_insert_with(AnalysisCache::default);
    if !cache.entries.contains_key(&key) {
        cache.order.push(key.clone());
        while cache.order.len() > ANALYSIS_CACHE_ENTRIES {
            let evicted = cache.order.remove(0);
            cache.entries.remove(&evicted);
        }
    }
    update(cache.entries.entry(key).or_default());
}

pub(crate) fn current_transition_settings() -> TransitionSettings {
    TRANSITION_SETTINGS
        .lock()
        .map(|settings| *settings)
        .unwrap_or_default()
        .sanitized()
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct TransitionSettingsOptions {
    /// `none` | `gapless` | `fade` | `automix-basic` | `automix-pro`
    pub mode: Option<String>,
    /// Crossfade length in seconds for `fade` (0–15).
    pub fade_secs: Option<f64>,
}

#[napi(object)]
#[derive(Clone, Debug, Default)]
pub struct TransitionSettingsSnapshot {
    pub mode: String,
    pub fade_secs: f64,
    /// Seconds before the end of the current track at which the renderer should have the
    /// next source prepared.
    pub prefetch_lead_secs: f64,
}

fn snapshot(settings: TransitionSettings) -> TransitionSettingsSnapshot {
    TransitionSettingsSnapshot {
        mode: settings.mode.as_str().to_string(),
        fade_secs: f64::from(settings.fade_secs),
        prefetch_lead_secs: settings.prefetch_lead_secs(),
    }
}

/// Configure the song-transition mode (QQ Music's 歌曲过渡设置).
#[napi]
pub fn set_transition_settings(
    options: Option<TransitionSettingsOptions>,
) -> napi::Result<TransitionSettingsSnapshot> {
    let options = options.unwrap_or_default();
    let mut settings = current_transition_settings();
    if let Some(mode) = options.mode.as_deref() {
        settings.mode = TransitionMode::parse(mode)
            .ok_or_else(|| napi::Error::from_reason(format!("unknown transition mode '{mode}'")))?;
    }
    if let Some(fade_secs) = options.fade_secs {
        settings.fade_secs = if fade_secs.is_finite() {
            fade_secs as f32
        } else {
            settings.fade_secs
        };
    }
    let settings = settings.sanitized();
    if let Ok(mut current) = TRANSITION_SETTINGS.lock() {
        *current = settings;
    }
    // Already prepared/active transitions were planned with the previous settings; drop
    // them so the renderer prepares again with the new ones.
    if RUNTIME_READY.load(Ordering::Acquire) {
        let _ = call_core_command("transition-settings-changed", |runtime| {
            if let Some(session) = runtime.session.as_ref() {
                if let Some(commands) = session.decode_commands.as_ref() {
                    let reset_position_secs = session.shared.position_secs();
                    if let Err(err) = commands.try_send(decoder::DecodeCommand::DisarmTransition {
                        request_id: None,
                        reset_position_secs: Some(reset_position_secs),
                    }) {
                        emit_runtime_event(
                            runtime,
                            PlayerEvent::log(
                                "warn",
                                format!("failed to disarm active song transition: {err}"),
                            ),
                        );
                    }
                }
            }
            runtime.cancel_pending_gapless_prepare();
            retire_prepared_next_background(runtime.prepared_next.take(), "transition-settings");
            runtime.armed_transition_request = None;
            Ok(())
        });
    }
    Ok(snapshot(settings))
}

#[napi]
pub fn get_transition_settings() -> napi::Result<TransitionSettingsSnapshot> {
    Ok(snapshot(current_transition_settings()))
}

/// JSON of the most recent transition decision (for debugging / tests).
#[napi]
pub fn get_transition_diagnostics() -> napi::Result<Option<String>> {
    Ok(LAST_PLAN_JSON.lock().ok().and_then(|plan| plan.clone()))
}

fn remember_plan(plan: &crate::transition::decide::TransitionPlan) {
    if let Ok(json) = serde_json::to_string(plan) {
        if let Ok(mut last) = LAST_PLAN_JSON.lock() {
            *last = Some(json);
        }
    }
}

/// Decode a window of a track into a [`TrackAnalysis`]. The decoder is left positioned
/// wherever the window ended; callers reopen or seek afterwards.
fn analyse_window(
    decoder: &mut decoder::DecoderData,
    window_start_secs: f64,
    window_secs: f64,
    interrupt: &PreparationCancellation,
) -> Result<TrackAnalysis, String> {
    let duration = decoder.duration_secs();
    let start = window_start_secs.max(0.0);
    if start > 0.0 {
        decoder.prepare_seamless_seek(start)?;
    }
    let mut analyzer: Option<TrackAnalyzer> = None;
    let mut collected = 0.0f64;
    let mut scratch = Vec::<f32>::new();
    let mut converter = crate::audio_graph::SwrMixConverter::default();
    let mut decode_errors = 0usize;
    while collected < window_secs {
        if interrupt.is_cancelled() {
            return Err("analysis cancelled".to_string());
        }
        let chunk = match decoder.decode_next_chunk() {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                // A seek into a partially cached network stream can leave the demuxer on
                // a frame it cannot resync from immediately. Skip a few bad frames; if it
                // keeps failing, analyse what we have instead of failing the prepare.
                decode_errors += 1;
                if decode_errors > ANALYSIS_MAX_DECODE_ERRORS || collected > 0.0 {
                    emit_event(PlayerEvent::log(
                        "warn",
                        format!("transition analysis stopped early after {collected:.1}s: {err}"),
                    ));
                    break;
                }
                continue;
            }
        };
        if chunk.frames == 0 {
            continue;
        }
        let chunk_start = chunk.pts_secs.unwrap_or(start + collected);
        let analyzer = analyzer.get_or_insert_with(|| {
            TrackAnalyzer::new(
                chunk.format.sample_rate,
                1,
                duration,
                if start > 0.0 { chunk_start } else { 0.0 },
            )
        });
        // Convert to mono f32 at the chunk's own rate.
        let mono_format = MixFormat::f32(chunk.format.sample_rate, 1);
        scratch.clear();
        converter.process(&chunk, mono_format, &mut scratch)?;
        analyzer.push_mono(&scratch);
        collected += chunk.frames as f64 / f64::from(chunk.format.sample_rate.max(1));
    }
    let Some(analyzer) = analyzer else {
        return Err("no audio decoded for analysis".to_string());
    };
    if collected < ANALYSIS_MIN_SECS {
        return Err(format!(
            "only {collected:.1}s of audio decoded for analysis"
        ));
    }
    Ok(analyzer.finish())
}

/// Ensure the outgoing track's tail analysis exists (decodes a separate reader).
fn ensure_tail_analysis(
    key: &str,
    url: &str,
    audio_stream_ordinal: Option<usize>,
    config: &PlayerConfig,
    interrupt: &PreparationCancellation,
    window_secs: f64,
) -> Result<TrackAnalysis, String> {
    let cached = cache_get(key);
    if let Some(tail) = cached.tail.as_ref() {
        if tail.covers_end()
            && (tail.window_end_secs - tail.window_start_secs) + 0.5
                >= window_secs.min(tail.duration_secs)
        {
            return Ok(tail.clone());
        }
    }
    let mut decoder = open_decoder_with_interrupt(
        url.to_string(),
        audio_stream_ordinal,
        None,
        interrupt.reader_interrupt(),
        config.packet_cache_options_for_url(url),
        &config.stream_options(),
    )?;
    let duration = decoder.duration_secs();
    if duration <= 0.0 {
        return Err("outgoing track duration unknown".to_string());
    }
    let start = (duration - window_secs).max(0.0);
    let analysis = match analyse_window(&mut decoder, start, window_secs + 1.0, interrupt) {
        Ok(analysis) => analysis,
        Err(first_err) => {
            if interrupt.is_cancelled() {
                return Err(first_err);
            }
            // Retry with a fresh reader and the short (silence-only) window: enough for a
            // trim-correct hand-off even when the long window cannot be decoded.
            let mut retry = open_decoder_with_interrupt(
                url.to_string(),
                audio_stream_ordinal,
                None,
                interrupt.reader_interrupt(),
                config.packet_cache_options_for_url(url),
                &config.stream_options(),
            )?;
            let short_start = (duration - GAPLESS_TAIL_WINDOW_SECS).max(0.0);
            analyse_window(
                &mut retry,
                short_start,
                GAPLESS_TAIL_WINDOW_SECS + 1.0,
                interrupt,
            )
            .map_err(|retry_err| format!("{first_err}; retry: {retry_err}"))?
        }
    };
    cache_put(key.to_string(), |entry| entry.tail = Some(analysis.clone()));
    Ok(analysis)
}

/// Analyse the head of the incoming decoder. The caller opens a fresh playback reader.
fn ensure_head_analysis(
    key: &str,
    decoder: &mut decoder::DecoderData,
    interrupt: &PreparationCancellation,
    window_secs: f64,
) -> Result<TrackAnalysis, String> {
    let cached = cache_get(key);
    if let Some(head) = cached.head.as_ref() {
        if head.covers_start()
            && (head.window_end_secs + 0.5 >= window_secs.min(head.duration_secs))
        {
            return Ok(head.clone());
        }
    }
    let analysis = analyse_window(decoder, 0.0, window_secs, interrupt)?;
    cache_put(key.to_string(), |entry| entry.head = Some(analysis.clone()));
    Ok(analysis)
}

pub(crate) struct PreparedTransitionInputs<'a> {
    pub next_url: &'a str,
    pub next_audio_stream_ordinal: Option<usize>,
    pub current_url: Option<&'a str>,
    pub current_audio_stream_ordinal: Option<usize>,
    pub config: &'a PlayerConfig,
    pub interrupt: &'a PreparationCancellation,
}

pub(crate) struct PreparedTransitionAudio {
    pub decoder: decoder::DecoderData,
    pub predecoded: Vec<shared::DecodedAudioChunk>,
    pub plan: Option<crate::transition::decide::TransitionPlan>,
}

pub(crate) fn prepare_transition_audio(
    sample_rate: u32,
    inputs: PreparedTransitionInputs<'_>,
) -> Result<PreparedTransitionAudio, String> {
    let open = || {
        if inputs.interrupt.is_cancelled() {
            return Err("next source preparation cancelled".to_string());
        }
        open_decoder_with_interrupt(
            inputs.next_url.to_string(),
            inputs.next_audio_stream_ordinal,
            Some(sample_rate),
            inputs.interrupt.reader_interrupt(),
            inputs.config.packet_cache_options_for_url(inputs.next_url),
            &inputs.config.stream_options(),
        )
    };
    let mut decoder = open()?;
    let settings = current_transition_settings();
    let analyse = settings.mode != TransitionMode::None && inputs.current_url.is_some();
    let plan = if analyse {
        let plan = match plan_prepared_transition(&mut decoder, &inputs, settings) {
            Ok(plan) => plan,
            Err(err) => {
                if inputs.interrupt.is_cancelled() {
                    return Err(err);
                }
                emit_event(PlayerEvent::log(
                    "warn",
                    format!("transition analysis failed; using plain gapless hand-off: {err}"),
                ));
                None
            }
        };
        // Analysis can consume B even if it fails or produces no plan. Always reopen;
        // reusing that reader would silently omit audio before its current position.
        drop(decoder);
        decoder = open()?;
        plan
    } else {
        None
    };
    let b_start = plan.as_ref().map_or(0.0, |plan| plan.b_start_secs).max(0.0);
    let direct_gapless = plan
        .as_ref()
        .is_some_and(|plan| plan.mode == TransitionMode::Gapless && plan.overlap_secs <= 0.0);
    if b_start > 0.0 && !direct_gapless {
        decoder.prepare_seamless_seek(b_start)?;
    }
    decoder.set_discard_before_secs(Some(b_start));
    let predecoded = predecode_gapless_head(&mut decoder, sample_rate)?;
    if inputs.interrupt.is_cancelled() {
        return Err("next source preparation cancelled".to_string());
    }
    Ok(PreparedTransitionAudio {
        decoder,
        predecoded,
        plan,
    })
}

/// Analyse both tracks and decide the cue points. The caller reopens B afterwards.
fn plan_prepared_transition(
    decoder: &mut decoder::DecoderData,
    inputs: &PreparedTransitionInputs<'_>,
    settings: TransitionSettings,
) -> Result<Option<crate::transition::decide::TransitionPlan>, String> {
    if settings.mode == TransitionMode::None {
        return Ok(None);
    }
    let Some(current_url) = inputs.current_url else {
        return Ok(None);
    };
    let next_key = cache_key(inputs.next_url, inputs.next_audio_stream_ordinal);
    let current_key = cache_key(current_url, inputs.current_audio_stream_ordinal);
    let (head_window, tail_window) = if settings.mode.is_automix() {
        (HEAD_WINDOW_SECS, TAIL_WINDOW_SECS)
    } else {
        (GAPLESS_HEAD_WINDOW_SECS, GAPLESS_TAIL_WINDOW_SECS)
    };
    let head = ensure_head_analysis(&next_key, decoder, inputs.interrupt, head_window)?;
    let tail = ensure_tail_analysis(
        &current_key,
        current_url,
        inputs.current_audio_stream_ordinal,
        inputs.config,
        inputs.interrupt,
        tail_window,
    )?;
    let request = TransitionRequest {
        settings,
        trigger: TransitionTrigger::EndOfTrack,
        a: &tail,
        b: &head,
        a_position_secs: 0.0,
    };
    let Some(plan) = decide_transition(&request) else {
        return Ok(None);
    };
    remember_plan(&plan);
    emit_event(PlayerEvent::log(
        "info",
        format!(
            "transition planned: mode={} a_cut={:.2}s a_end={:.2}s b_start={:.2}s overlap={:.2}s template={:?} tempo_ratio={:.4} ({})",
            plan.mode.as_str(),
            plan.a_cut_secs,
            plan.a_end_secs,
            plan.b_start_secs,
            plan.overlap_secs,
            plan.template,
            plan.a_tempo_ratio,
            plan.note
        ),
    ));
    Ok(Some(plan))
}

/// Linear loudness gain from dB (matches `SharedAudio::set_normalization_gain_db`).
pub(crate) fn normalization_gain_linear(gain_db: f32) -> f32 {
    if !gain_db.is_finite() {
        return 1.0;
    }
    10.0f32
        .powf(gain_db.clamp(-40.0, 24.0) / 20.0)
        .clamp(0.0, 16.0)
}

/// Assemble the armed transition from a prepared next source.
pub(crate) fn armed_transition_from_prepared(
    plan: crate::transition::decide::TransitionPlan,
    decoder: decoder::DecoderData,
    predecoded: Vec<shared::DecodedAudioChunk>,
    info: TrackSwitchInfo,
    preferred_output_sample_format: shared::AudioSampleFormat,
    current_normalization_gain_db: f32,
    next_normalization_gain_db: f32,
    request_id: u64,
    outgoing_seq: u64,
) -> ArmedTransition {
    let mut info = info;
    // The output callback multiplies everything by one normalisation gain, which it
    // switches when it crosses the boundary (= the start of the mixed audio). During the
    // overlap the mixer therefore pre-scales both decks relative to a common reference:
    // the *larger* of the two gains is applied by the callback, so neither deck is scaled
    // above unity inside the graph (its soft limiter would otherwise squash the louder
    // deck before the callback can attenuate it).
    let norm_a = normalization_gain_linear(current_normalization_gain_db);
    let norm_b = normalization_gain_linear(next_normalization_gain_db);
    let reference = norm_a.max(norm_b).max(1.0e-3);
    let reference_db = 20.0 * reference.log10();
    info.normalization_gain_db = Some(reference_db);
    ArmedTransition {
        plan,
        decoder: Box::new(decoder),
        predecoded,
        info,
        preferred_output_sample_format,
        a_gain: norm_a / reference,
        b_gain: norm_b / reference,
        // Once the outgoing deck is gone the callback gain must settle on B's own value.
        post_overlap_normalization_gain_db: next_normalization_gain_db,
        request_id,
        outgoing_seq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_evicts_oldest_entries() {
        for index in 0..(ANALYSIS_CACHE_ENTRIES + 3) {
            cache_put(format!("track-{index}"), |entry| {
                entry.head = Some(TrackAnalysis::default());
            });
        }
        assert!(cache_get("track-0").head.is_none());
        assert!(cache_get(&format!("track-{}", ANALYSIS_CACHE_ENTRIES + 2))
            .head
            .is_some());
    }

    #[test]
    fn deck_gains_keep_the_sum_consistent_with_the_boundary_switch() {
        let armed = armed_transition_from_prepared(
            crate::transition::decide::TransitionPlan {
                mode: TransitionMode::Fade,
                version: crate::transition::decide::DecisionVersion::Fade,
                trigger: TransitionTrigger::EndOfTrack,
                a_cut_secs: 0.0,
                a_end_secs: 1.0,
                b_start_secs: 0.0,
                overlap_secs: 1.0,
                template: None,
                a_tempo_ratio: 1.0,
                speed_type: crate::transition::decide::SpeedType::None,
                bpm_a: None,
                bpm_b: None,
                bars: None,
                a_beat_secs: None,
                b_beat_secs: None,
                note: String::new(),
            },
            test_decoder(),
            Vec::new(),
            TrackSwitchInfo::new("b".to_string(), None, 1, 10.0),
            shared::AudioSampleFormat::S16,
            -6.0,
            0.0,
            1,
            1,
        );
        // A at -6 dB, B at 0 dB: the callback applies the louder gain (0 dB) from the
        // boundary on; A is pre-scaled to ≈0.501, B stays at unity.
        assert!((armed.a_gain - 0.501).abs() < 0.01);
        assert_eq!(armed.b_gain, 1.0);
        assert!(armed.info.normalization_gain_db.unwrap().abs() < 1e-5);
        assert_eq!(armed.post_overlap_normalization_gain_db, 0.0);
        // Reverse case: A louder than B → B pre-scaled below unity, A at unity.
        let armed = armed_transition_from_prepared(
            crate::transition::decide::TransitionPlan {
                mode: TransitionMode::Fade,
                version: crate::transition::decide::DecisionVersion::Fade,
                trigger: TransitionTrigger::EndOfTrack,
                a_cut_secs: 0.0,
                a_end_secs: 1.0,
                b_start_secs: 0.0,
                overlap_secs: 1.0,
                template: None,
                a_tempo_ratio: 1.0,
                speed_type: crate::transition::decide::SpeedType::None,
                bpm_a: None,
                bpm_b: None,
                bars: None,
                a_beat_secs: None,
                b_beat_secs: None,
                note: String::new(),
            },
            test_decoder(),
            Vec::new(),
            TrackSwitchInfo::new("b".to_string(), None, 1, 10.0),
            shared::AudioSampleFormat::S16,
            6.0,
            -6.0,
            1,
            1,
        );
        assert_eq!(armed.a_gain, 1.0);
        assert!((armed.b_gain - 0.251).abs() < 0.01);
        assert!((armed.info.normalization_gain_db.unwrap() - 6.0).abs() < 1e-4);
        assert_eq!(armed.post_overlap_normalization_gain_db, -6.0);
    }

    fn test_decoder() -> decoder::DecoderData {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("vendor/ffmpeg-audio/crates/ffmpeg_audio/tests/assets/seek_test.aac");
        decoder::DecoderData::open(
            path.to_string_lossy().into_owned(),
            None,
            None,
            Arc::new(AtomicBool::new(false)),
            ffmpeg_audio::PacketCacheOptions::default(),
            &crate::stream::StreamOptions::default(),
        )
        .expect("test asset decoder")
    }
}
