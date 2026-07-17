use crate::device::selection::{
    device_name_matches_key, is_default_device_name, parse_device_key, select_named_output_device,
};
use crate::device::watcher::run_debounced_device_events;
use crate::events::{AudioDevice, PlayerEvent};
use cpal::traits::{DeviceTrait, HostTrait};
use std::ffi::{c_void, OsString};
use std::mem;
use std::os::windows::ffi::OsStringExt;
use std::slice;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use windows::core::{implement, PCWSTR, PWSTR};
use windows::Win32::Devices::Properties;
use windows::Win32::Foundation::{RPC_E_CHANGED_MODE, S_FALSE, S_OK};
use windows::Win32::Media::Audio::{
    eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
    IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
};
use windows::Win32::Media::{Audio, KernelStreaming, Multimedia};
use windows::Win32::System::Com::{
    self, CoCreateInstance, StructuredStorage, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Variant::VT_LPWSTR;

const DEFAULT_EXCLUSIVE_BUFFER_100NS: i64 = 200_000;
const WASAPI_DEVICE_KEY_PREFIX: &str = "wasapi:";
const DEVICE_KEY_SEPARATOR: &str = "\u{1f}";

#[derive(Clone, Copy)]
pub(crate) enum WasapiSampleFormat {
    F32,
    I16,
}

impl WasapiSampleFormat {
    pub(crate) fn sample_bytes(self) -> u16 {
        match self {
            Self::F32 => 4,
            Self::I16 => 2,
        }
    }
}

pub(crate) struct ComApartment {
    initialized: bool,
}

impl ComApartment {
    pub(crate) fn init() -> Result<Self, String> {
        let hr = unsafe { Com::CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == S_OK || hr == S_FALSE {
            Ok(Self { initialized: true })
        } else if hr == RPC_E_CHANGED_MODE {
            Ok(Self { initialized: false })
        } else {
            Err(format!("failed to initialize COM for WASAPI: {hr:?}"))
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                Com::CoUninitialize();
            }
        }
    }
}

pub struct DeviceWatcher {
    stop: Arc<AtomicBool>,
    sender: SyncSender<()>,
    thread: Option<JoinHandle<()>>,
}

impl DeviceWatcher {
    pub fn start(emit: fn(PlayerEvent)) -> Result<Option<Self>, String> {
        let (tx, rx) = sync_channel::<()>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_tx = tx.clone();
        let thread = thread::Builder::new()
            .name("player-device-watcher".to_string())
            .spawn(move || {
                if unsafe { Com::CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
                    return;
                }
                let enumerator = unsafe {
                    CoCreateInstance::<_, IMMDeviceEnumerator>(
                        &MMDeviceEnumerator,
                        None,
                        CLSCTX_ALL,
                    )
                };
                let Ok(enumerator) = enumerator else {
                    unsafe { Com::CoUninitialize() };
                    return;
                };
                let client =
                    IMMNotificationClient::from(DeviceNotificationClient { sender: thread_tx });
                if unsafe { enumerator.RegisterEndpointNotificationCallback(Some(&client)) }
                    .is_err()
                {
                    unsafe { Com::CoUninitialize() };
                    return;
                }

                run_debounced_device_events(rx, thread_stop, emit);

                let _ = unsafe { enumerator.UnregisterEndpointNotificationCallback(Some(&client)) };
                unsafe { Com::CoUninitialize() };
            })
            .map_err(|err| format!("failed to spawn device watcher thread: {err}"))?;
        Ok(Some(Self {
            stop,
            sender: tx,
            thread: Some(thread),
        }))
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.sender.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[implement(IMMNotificationClient)]
struct DeviceNotificationClient {
    sender: SyncSender<()>,
}

#[allow(non_snake_case)]
impl IMMNotificationClient_Impl for DeviceNotificationClient_Impl {
    fn OnDeviceStateChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _dwnewstate: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        self.notify();
        Ok(())
    }

    fn OnDeviceAdded(&self, _pwstrdeviceid: &PCWSTR) -> windows::core::Result<()> {
        self.notify();
        Ok(())
    }

    fn OnDeviceRemoved(&self, _pwstrdeviceid: &PCWSTR) -> windows::core::Result<()> {
        self.notify();
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        _role: ERole,
        _pwstrdefaultdeviceid: &PCWSTR,
    ) -> windows::core::Result<()> {
        if flow == eRender {
            self.notify();
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _pwstrdeviceid: &PCWSTR,
        _key: &windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY,
    ) -> windows::core::Result<()> {
        self.notify();
        Ok(())
    }
}

impl DeviceNotificationClient {
    fn notify(&self) {
        match self.sender.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => {}
            Err(TrySendError::Disconnected(())) => {}
        }
    }
}

impl DeviceNotificationClient_Impl {
    fn notify(&self) {
        self.this.notify();
    }
}

pub(crate) fn validate_wasapi_output_device(device_name: &str) -> Result<(), String> {
    let _com = ComApartment::init()?;
    let device = resolve_wasapi_output_device(device_name)?;
    let sample_rate = resolve_wasapi_output_sample_rate(device_name);
    let audio_client = activate_wasapi_audio_client(&device)?;
    let sample_format = choose_wasapi_sample_format(&audio_client, sample_rate)?;
    let wave_format = wasapi_wave_format(sample_rate, sample_format);
    let buffer_duration = wasapi_exclusive_buffer_duration(&audio_client);
    unsafe {
        audio_client
            .Initialize(
                Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                buffer_duration,
                buffer_duration,
                &wave_format.Format,
                None,
            )
            .map_err(|err| format!("failed to validate WASAPI exclusive output: {err}"))
    }
}

pub(crate) fn list_output_devices() -> Option<Vec<AudioDevice>> {
    let _com = ComApartment::init().ok()?;
    let enumerator = device_enumerator().ok()?;
    let default_endpoint_id = default_render_endpoint_id(&enumerator);
    let collection = unsafe {
        enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .ok()?
    };
    let count = unsafe { collection.GetCount().ok()? };

    let mut endpoints = Vec::<(String, String)>::new();
    for index in 0..count {
        let device = unsafe { collection.Item(index).ok()? };
        let endpoint_id = endpoint_id(&device).ok()?;
        let friendly_name = friendly_name(&device).ok()?;
        if is_hidden_output_device_name(&friendly_name) {
            continue;
        }
        endpoints.push((endpoint_id, friendly_name));
    }

    let mut duplicate_counts = std::collections::HashMap::<String, usize>::new();
    for (_, friendly_name) in &endpoints {
        *duplicate_counts.entry(friendly_name.clone()).or_insert(0) += 1;
    }

    let mut occurrences = std::collections::HashMap::<String, usize>::new();
    let devices = endpoints
        .into_iter()
        .map(|(endpoint_id, friendly_name)| {
            let occurrence = occurrences.entry(friendly_name.clone()).or_insert(0);
            let duplicate_count = duplicate_counts.get(&friendly_name).copied().unwrap_or(1);
            let mut description = if duplicate_count > 1 {
                format!("{} #{}", friendly_name, *occurrence + 1)
            } else {
                friendly_name
            };
            *occurrence += 1;

            if default_endpoint_id.as_deref() == Some(endpoint_id.as_str()) {
                description = format!("{description} (默认)");
            }

            AudioDevice {
                name: format!("{WASAPI_DEVICE_KEY_PREFIX}{endpoint_id}"),
                description,
            }
        })
        .collect::<Vec<_>>();
    (!devices.is_empty()).then_some(devices)
}

fn is_hidden_output_device_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    normalized.is_empty() || normalized == "system default" || normalized == "default"
}

fn device_key(raw_name: &str, occurrence: usize) -> String {
    if occurrence == 0 {
        raw_name.to_string()
    } else {
        format!("{raw_name}{DEVICE_KEY_SEPARATOR}{occurrence}")
    }
}

fn endpoint_id_for_friendly_name(device_name: &str) -> Option<String> {
    let selector = parse_device_key(device_name);
    let mut occurrence = 0usize;
    let _com = ComApartment::init().ok()?;
    let enumerator = device_enumerator().ok()?;
    unsafe {
        let collection = enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .ok()?;
        let count = collection.GetCount().ok()?;
        for index in 0..count {
            let device = collection.Item(index).ok()?;
            let friendly_name = friendly_name(&device).unwrap_or_default();
            if !device_name_matches_key(&friendly_name, &selector) {
                continue;
            }
            if occurrence == selector.occurrence {
                return endpoint_id(&device).ok();
            }
            occurrence += 1;
        }
    }
    None
}

fn friendly_name_for_endpoint_id(endpoint_id: &str) -> Option<String> {
    let _com = ComApartment::init().ok()?;
    let enumerator = device_enumerator().ok()?;
    let wide = endpoint_id
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let device = unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())).ok()? };
    friendly_name(&device).ok()
}

fn cpal_device_key_for_endpoint_id(target_endpoint_id: &str) -> Option<String> {
    let endpoint_name = friendly_name_for_endpoint_id(target_endpoint_id)?;
    let endpoint_index = {
        let selector = parse_device_key(&endpoint_name);
        let mut occurrence = 0usize;
        let _com = ComApartment::init().ok()?;
        let enumerator = device_enumerator().ok()?;
        let collection = unsafe {
            enumerator
                .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
                .ok()?
        };
        let count = unsafe { collection.GetCount().ok()? };
        let mut index = 0usize;
        for endpoint in 0..count {
            let device = unsafe { collection.Item(endpoint).ok()? };
            let name = friendly_name(&device).unwrap_or_default();
            if !device_name_matches_key(&name, &selector) {
                continue;
            }
            let current_endpoint_id = endpoint_id(&device).ok()?;
            if current_endpoint_id == target_endpoint_id {
                index = occurrence;
                break;
            }
            occurrence += 1;
        }
        index
    };
    Some(device_key(&endpoint_name, endpoint_index))
}

pub(crate) fn resolve_wasapi_output_sample_rate(device_name: &str) -> u32 {
    let host = cpal::default_host();
    let device = if is_default_device_name(device_name) {
        host.default_output_device()
    } else if is_wasapi_device_key(device_name) {
        resolve_wasapi_device_name(device_name).and_then(|device_key| {
            let selector = parse_device_key(&device_key);
            select_named_output_device(&host, &selector)
        })
    } else {
        let selector = parse_device_key(device_name);
        select_named_output_device(&host, &selector)
    };
    device
        .and_then(|device| device.default_output_config().ok())
        .map(|config| config.sample_rate().0)
        .unwrap_or(48_000)
}

pub(crate) fn resolve_wasapi_output_device(device_name: &str) -> Result<Audio::IMMDevice, String> {
    let enumerator = device_enumerator()?;
    if is_default_device_name(device_name) {
        return unsafe {
            enumerator
                .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
                .map_err(|err| format!("failed to get default WASAPI output device: {err}"))
        };
    }
    if let Some(endpoint_id) = device_name.strip_prefix(WASAPI_DEVICE_KEY_PREFIX) {
        let wide = endpoint_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        return unsafe {
            enumerator
                .GetDevice(PCWSTR(wide.as_ptr()))
                .map_err(|err| format!("failed to get WASAPI output device by endpoint id: {err}"))
        };
    }
    if let Some(endpoint_id) = endpoint_id_for_friendly_name(device_name) {
        let wide = endpoint_id
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        return unsafe {
            enumerator.GetDevice(PCWSTR(wide.as_ptr())).map_err(|err| {
                format!("failed to get WASAPI output device by friendly name: {err}")
            })
        };
    }

    Err(format!("WASAPI output device not found: {device_name}"))
}

pub(crate) fn resolve_wasapi_device_name(device_key: &str) -> Option<String> {
    let endpoint_id = device_key.strip_prefix(WASAPI_DEVICE_KEY_PREFIX)?;
    cpal_device_key_for_endpoint_id(endpoint_id)
        .or_else(|| friendly_name_for_endpoint_id(endpoint_id))
}

pub(crate) fn is_wasapi_device_key(value: &str) -> bool {
    value.starts_with(WASAPI_DEVICE_KEY_PREFIX)
}

pub(crate) fn activate_wasapi_audio_client(
    device: &Audio::IMMDevice,
) -> Result<Audio::IAudioClient, String> {
    unsafe {
        device
            .Activate::<Audio::IAudioClient>(Com::CLSCTX_ALL, None)
            .map_err(|err| format!("failed to activate WASAPI audio client: {err}"))
    }
}

pub(crate) fn choose_wasapi_sample_format(
    audio_client: &Audio::IAudioClient,
    sample_rate: u32,
) -> Result<WasapiSampleFormat, String> {
    for sample_format in [WasapiSampleFormat::F32, WasapiSampleFormat::I16] {
        let wave_format = wasapi_wave_format(sample_rate, sample_format);
        let result = unsafe {
            audio_client.IsFormatSupported(
                Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                &wave_format.Format,
                None,
            )
        };
        if result == S_OK {
            return Ok(sample_format);
        }
    }
    Err(format!(
        "WASAPI exclusive output does not accept stereo PCM at {sample_rate} Hz"
    ))
}

pub(crate) fn wasapi_wave_format(
    sample_rate: u32,
    sample_format: WasapiSampleFormat,
) -> Audio::WAVEFORMATEXTENSIBLE {
    let channels = crate::shared::TARGET_CHANNELS as u16;
    let sample_bytes = sample_format.sample_bytes();
    let block_align = channels * sample_bytes;
    let bits_per_sample = sample_bytes * 8;
    let format = Audio::WAVEFORMATEX {
        wFormatTag: KernelStreaming::WAVE_FORMAT_EXTENSIBLE as u16,
        nChannels: channels,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits_per_sample,
        cbSize: (mem::size_of::<Audio::WAVEFORMATEXTENSIBLE>()
            - mem::size_of::<Audio::WAVEFORMATEX>()) as u16,
    };
    let sub_format = match sample_format {
        WasapiSampleFormat::F32 => Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
        WasapiSampleFormat::I16 => KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM,
    };
    Audio::WAVEFORMATEXTENSIBLE {
        Format: format,
        Samples: Audio::WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: bits_per_sample,
        },
        dwChannelMask: KernelStreaming::KSAUDIO_SPEAKER_DIRECTOUT,
        SubFormat: sub_format,
    }
}

pub(crate) fn wasapi_exclusive_buffer_duration(audio_client: &Audio::IAudioClient) -> i64 {
    let mut default_period = 0i64;
    let mut minimum_period = 0i64;
    let result = unsafe {
        audio_client.GetDevicePeriod(Some(&mut default_period), Some(&mut minimum_period))
    };
    if result.is_ok() && default_period > 0 {
        default_period
    } else {
        DEFAULT_EXCLUSIVE_BUFFER_100NS
    }
}

fn device_enumerator() -> Result<Audio::IMMDeviceEnumerator, String> {
    unsafe {
        Com::CoCreateInstance::<_, Audio::IMMDeviceEnumerator>(
            &Audio::MMDeviceEnumerator,
            None,
            Com::CLSCTX_ALL,
        )
        .map_err(|err| format!("failed to create WASAPI device enumerator: {err}"))
    }
}

fn default_render_endpoint_id(enumerator: &Audio::IMMDeviceEnumerator) -> Option<String> {
    let device = unsafe {
        enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
            .ok()?
    };
    endpoint_id(&device).ok()
}

fn friendly_name(device: &Audio::IMMDevice) -> Result<String, String> {
    unsafe {
        let store = device
            .OpenPropertyStore(STGM_READ)
            .map_err(|err| format!("failed to open WASAPI property store: {err}"))?;
        let mut value = store
            .GetValue(&Properties::DEVPKEY_Device_FriendlyName as *const _ as *const _)
            .map_err(|err| format!("failed to read WASAPI device name: {err}"))?;
        let variant = &value.as_raw().Anonymous.Anonymous;
        if variant.vt != VT_LPWSTR.0 {
            let _ = StructuredStorage::PropVariantClear(&mut value);
            return Err("WASAPI device name has unexpected property type".to_string());
        }

        let ptr_utf16 = *(&variant.Anonymous as *const _ as *const *const u16);
        let mut len = 0;
        while *ptr_utf16.add(len) != 0 {
            len += 1;
        }
        let name = OsString::from_wide(slice::from_raw_parts(ptr_utf16, len))
            .to_string_lossy()
            .into_owned();
        let _ = StructuredStorage::PropVariantClear(&mut value);
        Ok(name)
    }
}

fn endpoint_id(device: &Audio::IMMDevice) -> Result<String, String> {
    let value = unsafe {
        device
            .GetId()
            .map_err(|err| format!("failed to read WASAPI endpoint id: {err}"))?
    };
    pwstr_to_string_and_free(value)
}

fn pwstr_to_string_and_free(value: PWSTR) -> Result<String, String> {
    let result = unsafe {
        value
            .to_string()
            .map_err(|err| format!("failed to decode WASAPI endpoint id: {err}"))
    };
    unsafe {
        Com::CoTaskMemFree(Some(value.as_ptr() as *const c_void));
    }
    result
}
