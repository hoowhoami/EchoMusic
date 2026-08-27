use super::*;

mod dsp;
mod fade;
mod graph;
mod output;
mod output_lifecycle;
mod provider;
mod seek;
mod spectrum;

fn ensure_finite_parameter(value: f64, name: &str) -> napi::Result<()> {
    if value.is_finite() {
        Ok(())
    } else {
        Err(napi::Error::from_reason(format!(
            "{name} must be a finite number"
        )))
    }
}

pub(crate) use dsp::{prepare_dsp_settings_for_mix_rate, sync_current_session_dsp_settings};
pub use dsp::{
    set_audio_effect, set_equalizer, set_normalization_gain, set_speed, SetAudioEffectTask,
    SetEqualizerTask, SetNormalizationGainTask, SetSpeedTask,
};
pub use fade::{cancel_fade, fade, pause_with_fade, play_with_fade, FadeTask};
pub use graph::{
    get_audio_graph, set_audio_graph_parameter, set_audio_graph_plan, SetAudioGraphParameterTask,
    SetAudioGraphPlanTask,
};
pub use output::{
    get_audio_devices, set_audio_output, set_http_proxy, set_network_timeout,
    set_pause_on_device_disconnect, set_stall_timeout, GetAudioDevicesTask, SetAudioOutputTask,
};
pub(crate) use output_lifecycle::{
    handle_output_device_list_change, handle_playback_output_device_event, request_output_recovery,
    restart_output_for_runtime, schedule_idle_output_release_for_runtime,
};
pub use provider::inspect_dsp_provider;
pub(crate) use seek::{
    attach_restarted_decoder, mark_seek_plan_failed, open_decoder_at_position, SeekPlan,
};
pub use seek::{seek, SeekTask};
pub use spectrum::{
    configure_spectrum, get_spectrum_snapshot, get_spectrum_status, GetSpectrumSnapshotTask,
};
