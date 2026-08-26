use libloading::{Library, Symbol};
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::Path;
use std::ptr::NonNull;

pub const PROVIDER_ABI_VERSION: u32 = 2;
// These values describe the physical output context, not an effect module.
pub const PROVIDER_MODE_HEADPHONE: u32 = 0;
pub const PROVIDER_MODE_SPEAKER: u32 = 1;
#[derive(Clone, Debug, Default)]
pub struct ProviderDescriptor {
    pub id: String,
    pub version: String,
    pub latency_frames: u32,
    pub preferred_block_frames: u32,
    pub max_channels: u32,
    pub manifest_json: String,
    pub state_json: String,
}

#[repr(C)]
pub struct EchoDspConfig {
    pub abi_version: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub preferred_block_frames: u32,
    pub mode: u32,
    pub resource_json: *const c_char,
    pub preset_json: *const c_char,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct EchoDspInfo {
    pub abi_version: u32,
    pub latency_frames: u32,
    pub preferred_block_frames: u32,
    pub max_channels: u32,
    pub provider_id: *const c_char,
    pub provider_version: *const c_char,
    pub manifest_json: *const c_char,
    pub state_json: *const c_char,
}

#[repr(C)]
pub struct EchoDspApi {
    pub abi_version: u32,
    pub create: Option<unsafe extern "C" fn(*const EchoDspConfig, *mut EchoDspInfo) -> *mut c_void>,
    pub process: Option<unsafe extern "C" fn(*mut c_void, *mut f32, u32, u32) -> i32>,
    pub drain: Option<unsafe extern "C" fn(*mut c_void, *mut f32, u32, *mut u32) -> i32>,
    pub reset: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub configure: Option<unsafe extern "C" fn(*mut c_void, *const c_char) -> i32>,
    pub get_state_json: Option<unsafe extern "C" fn(*mut c_void) -> *const c_char>,
    pub destroy: Option<unsafe extern "C" fn(*mut c_void)>,
}

type GetApi = unsafe extern "C" fn() -> *const EchoDspApi;

pub struct NativeDspProvider {
    library: Library,
    api: NonNull<EchoDspApi>,
    instance: NonNull<c_void>,
    info: EchoDspInfo,
}

unsafe impl Send for NativeDspProvider {}

impl NativeDspProvider {
    pub fn load(
        path: &Path,
        sample_rate: u32,
        channels: u32,
        mode: u32,
        preset_json: Option<&str>,
        resource_json: Option<&str>,
    ) -> Result<Self, String> {
        let library = unsafe {
            Library::new(path).map_err(|error| format!("failed to load DSP provider: {error}"))?
        };
        let get_api: Symbol<GetApi> = unsafe {
            library
                .get(b"echo_dsp_get_api\0")
                .map_err(|error| format!("DSP provider has no echo_dsp_get_api: {error}"))?
        };
        let api_ptr = unsafe { get_api() };
        let api = NonNull::new(api_ptr as *mut EchoDspApi)
            .ok_or_else(|| "DSP provider returned a null API".to_string())?;
        let api_ref = unsafe { api.as_ref() };
        if api_ref.abi_version != PROVIDER_ABI_VERSION {
            return Err(format!(
                "unsupported DSP provider ABI: expected {}, got {}",
                PROVIDER_ABI_VERSION, api_ref.abi_version
            ));
        }
        let create = api_ref
            .create
            .ok_or_else(|| "DSP provider API has no create function".to_string())?;
        if api_ref.process.is_none()
            || api_ref.drain.is_none()
            || api_ref.reset.is_none()
            || api_ref.configure.is_none()
            || api_ref.get_state_json.is_none()
            || api_ref.destroy.is_none()
        {
            return Err("DSP provider API is incomplete".to_string());
        }

        let preset = c_string(preset_json)?;
        let resource_json = c_string(resource_json)?;
        let config = EchoDspConfig {
            abi_version: PROVIDER_ABI_VERSION,
            sample_rate,
            channels,
            preferred_block_frames: 512,
            mode,
            resource_json: optional_ptr(resource_json.as_ref()),
            preset_json: optional_ptr(preset.as_ref()),
        };
        let mut info = EchoDspInfo::default();
        let instance = unsafe { create(&config, &mut info) };
        let instance =
            NonNull::new(instance).ok_or_else(|| "DSP provider create failed".to_string())?;
        if info.abi_version != 0 && info.abi_version != PROVIDER_ABI_VERSION {
            unsafe { api_ref.destroy.expect("validated destroy")(instance.as_ptr()) };
            return Err("DSP provider returned an incompatible instance ABI".to_string());
        }
        if info.max_channels != 0 && channels > info.max_channels {
            unsafe { api_ref.destroy.expect("validated destroy")(instance.as_ptr()) };
            return Err(format!(
                "DSP provider supports at most {} channels, requested {}",
                info.max_channels, channels
            ));
        }
        Ok(Self {
            library,
            api,
            instance,
            info,
        })
    }

    pub fn info(&self) -> EchoDspInfo {
        self.info
    }

    pub fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            id: provider_string(self.info.provider_id).unwrap_or_default(),
            version: provider_string(self.info.provider_version).unwrap_or_default(),
            latency_frames: self.info.latency_frames,
            preferred_block_frames: self.info.preferred_block_frames,
            max_channels: self.info.max_channels,
            manifest_json: provider_string(self.info.manifest_json).unwrap_or_default(),
            state_json: provider_string(self.info.state_json).unwrap_or_default(),
        }
    }

    pub fn process(&mut self, samples: &mut [f32], channels: usize) -> Result<(), String> {
        let api = unsafe { self.api.as_ref() };
        let process = api.process.expect("validated process");
        let frames = samples.len() / channels.max(1);
        let result = unsafe {
            process(
                self.instance.as_ptr(),
                samples.as_mut_ptr(),
                frames as u32,
                channels as u32,
            )
        };
        if result < 0 {
            Err(format!("DSP provider process failed: {result}"))
        } else {
            Ok(())
        }
    }

    pub fn reset(&mut self) -> Result<(), String> {
        let api = unsafe { self.api.as_ref() };
        let result = unsafe { api.reset.expect("validated reset")(self.instance.as_ptr()) };
        if result < 0 {
            Err(format!("DSP provider reset failed: {result}"))
        } else {
            Ok(())
        }
    }

    pub fn configure(&mut self, preset_json: &str) -> Result<(), String> {
        let value = c_string(Some(preset_json))?;
        let api = unsafe { self.api.as_ref() };
        let result = unsafe {
            api.configure.expect("validated configure")(
                self.instance.as_ptr(),
                value
                    .as_ref()
                    .expect("configure JSON must be present")
                    .as_ptr(),
            )
        };
        if result < 0 {
            return Err(format!("DSP provider configure failed: {result}"));
        }
        self.refresh_state()
    }

    pub fn refresh_state(&mut self) -> Result<(), String> {
        let api = unsafe { self.api.as_ref() };
        let state = unsafe {
            api.get_state_json.expect("validated get_state_json")(self.instance.as_ptr())
        };
        if state.is_null() {
            return Err("DSP provider returned a null state JSON".to_string());
        }
        self.info.state_json = state;
        // ABI v2's create-time info is a snapshot. Presets can change the
        // processing delay without recreating the instance; newer engines
        // publish their current delay in state JSON. Older engines retain
        // their existing info value when this optional field is absent.
        if let Some(latency) = provider_string(state)
            .as_deref()
            .and_then(state_latency_frames)
        {
            self.info.latency_frames = latency;
        }
        Ok(())
    }

    pub fn drain(&mut self, output: &mut Vec<f32>, channels: usize) -> Result<(), String> {
        let api = unsafe { self.api.as_ref() };
        let drain = api.drain.expect("validated drain");
        let channels = channels.max(1);
        let capacity_frames = 4096u32;
        let mut buffer = vec![0.0f32; capacity_frames as usize * channels];
        loop {
            let mut written_frames = 0u32;
            let result = unsafe {
                drain(
                    self.instance.as_ptr(),
                    buffer.as_mut_ptr(),
                    capacity_frames,
                    &mut written_frames,
                )
            };
            if result < 0 {
                return Err(format!("DSP provider drain failed: {result}"));
            }
            if written_frames == 0 {
                return Ok(());
            }
            output.extend_from_slice(&buffer[..written_frames as usize * channels]);
            if written_frames < capacity_frames {
                return Ok(());
            }
        }
    }
}

impl Drop for NativeDspProvider {
    fn drop(&mut self) {
        let api = unsafe { self.api.as_ref() };
        unsafe { api.destroy.expect("validated destroy")(self.instance.as_ptr()) };
        let _ = &self.library;
    }
}

fn c_string(value: Option<&str>) -> Result<Option<CString>, String> {
    value
        .map(|value| {
            CString::new(value).map_err(|_| "DSP provider config contains NUL".to_string())
        })
        .transpose()
}

fn optional_ptr(value: Option<&CString>) -> *const c_char {
    value.map_or(std::ptr::null(), |value| value.as_ptr())
}

fn state_latency_frames(state: &str) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_str(state).ok()?;
    u32::try_from(value.get("latencyFrames")?.as_u64()?).ok()
}

#[allow(dead_code)]
fn provider_string(value: *const c_char) -> Option<String> {
    (!value.is_null()).then(|| {
        unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_latency_is_optional_nonnegative_integer() {
        assert_eq!(state_latency_frames(r#"{"latencyFrames":256}"#), Some(256));
        assert_eq!(state_latency_frames(r#"{"latencyFrames":0}"#), Some(0));
        for state in [
            "{}",
            "not JSON",
            r#"{"opaque":{"latencyFrames":256}}"#,
            r#"{"latencyFrames":null}"#,
            r#"{"latencyFrames":"256"}"#,
            r#"{"latencyFrames":-1}"#,
            r#"{"latencyFrames":1.5}"#,
            r#"{"latencyFrames":4294967296}"#,
        ] {
            assert_eq!(state_latency_frames(state), None, "{state}");
        }
    }

    #[test]
    #[ignore = "requires ECHO_TEST_DSP_PROVIDER pointing to EchoMusicViper 0.8.1+ with ViPERDSP"]
    fn runtime_preset_latency_refreshes() {
        let path = std::env::var_os("ECHO_TEST_DSP_PROVIDER").expect("provider library path");
        let mut provider = NativeDspProvider::load(
            Path::new(&path),
            48000,
            2,
            PROVIDER_MODE_HEADPHONE,
            Some(r#"{"presetId":"kugou-hifi-live"}"#),
            None,
        )
        .expect("load reference engine");
        assert_eq!(provider.info().latency_frames, 4863);
        for (id, latency) in [
            ("kugou-vinyl", 256),
            ("kugou-clear-vocal", 0),
            ("kugou-hifi-live", 4863),
            ("kugou-vinyl", 256),
        ] {
            provider
                .configure(&format!(r#"{{"presetId":"{id}"}}"#))
                .unwrap();
            assert_eq!(provider.info().latency_frames, latency);
            assert_eq!(provider.descriptor().latency_frames, latency);
        }
        assert!(provider
            .configure(r#"{"presetId":"kugou-vinyl","controls":{"aging":50}}"#)
            .is_err());
        assert_eq!(provider.info().latency_frames, 256);
    }

    #[test]
    #[ignore = "requires ECHO_TEST_DSP_PROVIDER pointing to EchoMusicViper 0.9.0+ with ViPERDSP"]
    fn runtime_preset_controls_round_trip() {
        let path = std::env::var_os("ECHO_TEST_DSP_PROVIDER").expect("provider library path");
        let mut provider = NativeDspProvider::load(
            Path::new(&path),
            48000,
            2,
            PROVIDER_MODE_HEADPHONE,
            Some(r#"{"presetId":"kugou-vinyl"}"#),
            None,
        )
        .expect("load reference engine");
        let manifest: serde_json::Value =
            serde_json::from_str(&provider.descriptor().manifest_json).unwrap();
        let lp = manifest["presets"]
            .as_array()
            .unwrap()
            .iter()
            .find(|preset| preset["id"] == "kugou-vinyl")
            .unwrap();
        assert_eq!(lp["controls"].as_array().unwrap().len(), 2);
        for (year, aging) in [(1900, 37), (1930, 100), (1960, 50), (1980, 1), (2010, 0)] {
            provider.configure(&format!(r#"{{"presetId":"kugou-vinyl","controls":{{"year":{{"value":{year}}},"aging":{{"value":{aging}}}}}}}"#)).unwrap();
            let state: serde_json::Value =
                serde_json::from_str(&provider.descriptor().state_json).unwrap();
            assert_eq!(state["effect"]["id"], "kugou-vinyl");
            assert_eq!(state["controls"]["year"]["value"], year);
            assert_eq!(state["controls"]["aging"]["value"], aging);
            assert_eq!(provider.info().latency_frames, 256);
            assert!(provider
                .configure(r#"{"presetId":"kugou-vinyl","controls":{"aging":{"value":101}}}"#)
                .is_err());
            provider.refresh_state().unwrap();
            let after: serde_json::Value =
                serde_json::from_str(&provider.descriptor().state_json).unwrap();
            assert_eq!(state, after);
        }
    }

    #[test]
    #[ignore = "requires ECHO_TEST_DSP_PROVIDER pointing to EchoMusicViper 0.10.0+ with ViPERDSP"]
    fn runtime_preset_rotation_controls_and_latency() {
        let path = std::env::var_os("ECHO_TEST_DSP_PROVIDER").expect("provider library path");
        for (rate, latency) in [(44100, 383), (48000, 857), (96000, 1169)] {
            let mut provider = NativeDspProvider::load(
                Path::new(&path),
                rate,
                2,
                PROVIDER_MODE_HEADPHONE,
                Some(r#"{"presetId":"kugou-vinyl"}"#),
                None,
            )
            .expect("load reference engine");
            assert_eq!(provider.info().latency_frames, 256);
            for speed in [0, 1, 10, 11, 20] {
                provider.configure(&format!(r#"{{"presetId":"kugou-3d-rotation","controls":{{"speed":{{"value":{speed}}}}}}}"#)).unwrap();
                let state: serde_json::Value =
                    serde_json::from_str(&provider.descriptor().state_json).unwrap();
                assert_eq!(state["effect"]["id"], "kugou-3d-rotation");
                assert_eq!(state["controls"]["speed"]["value"], speed);
                assert_eq!(provider.info().latency_frames, latency);
                assert_eq!(provider.descriptor().latency_frames, latency);
                assert!(provider
                    .configure(
                        r#"{"presetId":"kugou-3d-rotation","controls":{"speed":{"value":21}}}"#
                    )
                    .is_err());
                provider.refresh_state().unwrap();
                assert_eq!(
                    state,
                    serde_json::from_str::<serde_json::Value>(&provider.descriptor().state_json)
                        .unwrap()
                );
            }
            provider.configure(r#"{"presetId":"kugou-vinyl"}"#).unwrap();
            assert_eq!(provider.info().latency_frames, 256);
        }
    }
}
