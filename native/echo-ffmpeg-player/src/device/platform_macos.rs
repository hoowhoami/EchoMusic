use crate::device::watcher::run_debounced_device_events;
use crate::events::{AudioDevice, PlayerEvent};
use coreaudio_sys as ca;
use objc2_core_audio_types::AudioBufferList;
use std::ffi::{c_char, c_void, CStr};
use std::mem;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

const COREAUDIO_DEVICE_KEY_PREFIX: &str = "coreaudio:";
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

type CFStringRef = *const c_void;
type CFIndex = isize;
type Boolean = u8;

extern "C" {
    fn CFStringGetCString(
        the_string: CFStringRef,
        buffer: *mut c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> Boolean;
}

pub(crate) fn list_output_devices() -> Option<Vec<AudioDevice>> {
    let mut devices = Vec::new();
    for id in all_audio_devices()? {
        if !has_output_streams(id) {
            continue;
        }
        let Some(name) = device_name(id) else {
            continue;
        };
        let uid = device_uid(id).unwrap_or_else(|| id.to_string());
        devices.push(AudioDevice {
            name: format!("{COREAUDIO_DEVICE_KEY_PREFIX}{uid}"),
            description: name,
        });
    }
    (!devices.is_empty()).then_some(devices)
}

pub(crate) fn is_coreaudio_device_key(value: &str) -> bool {
    value.starts_with(COREAUDIO_DEVICE_KEY_PREFIX)
}

pub(crate) fn resolve_coreaudio_device_name(device_key: &str) -> Option<String> {
    let uid = device_key.strip_prefix(COREAUDIO_DEVICE_KEY_PREFIX)?;
    for id in all_audio_devices()? {
        if device_uid(id).as_deref() == Some(uid) {
            return device_name(id);
        }
    }
    None
}

pub(crate) fn acquire_exclusive(
    _device_name: &str,
) -> Result<Option<crate::exclusive::ExclusiveGuard>, String> {
    Ok(Some(crate::exclusive::ExclusiveGuard))
}

pub struct DeviceWatcher {
    stop: Arc<AtomicBool>,
    sender: SyncSender<()>,
    thread: Option<JoinHandle<()>>,
    listeners: Vec<CoreAudioPropertyListener>,
}

impl DeviceWatcher {
    pub fn start(emit: fn(PlayerEvent)) -> Result<Option<Self>, String> {
        let (tx, rx) = sync_channel::<()>(8);
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let listeners = register_coreaudio_device_listeners(tx.clone())?;
        let thread = thread::Builder::new()
            .name("player-device-watcher".to_string())
            .spawn(move || run_debounced_device_events(rx, thread_stop, emit))
            .map_err(|err| format!("failed to spawn CoreAudio device watcher: {err}"))?;
        let _ = tx.try_send(());
        Ok(Some(Self {
            stop,
            sender: tx,
            thread: Some(thread),
            listeners,
        }))
    }
}

impl Drop for DeviceWatcher {
    fn drop(&mut self) {
        self.listeners.clear();
        self.stop.store(true, Ordering::Release);
        let _ = self.sender.try_send(());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct CoreAudioPropertyListener {
    object_id: ca::AudioObjectID,
    address: ca::AudioObjectPropertyAddress,
    context: *mut SyncSender<()>,
}

unsafe impl Send for CoreAudioPropertyListener {}

impl Drop for CoreAudioPropertyListener {
    fn drop(&mut self) {
        unsafe {
            ca::AudioObjectRemovePropertyListener(
                self.object_id,
                &self.address,
                Some(coreaudio_device_listener),
                self.context.cast(),
            );
            drop(Box::from_raw(self.context));
        }
    }
}

fn register_coreaudio_device_listeners(
    sender: SyncSender<()>,
) -> Result<Vec<CoreAudioPropertyListener>, String> {
    [
        ca::kAudioHardwarePropertyDevices,
        ca::kAudioHardwarePropertyDefaultOutputDevice,
        ca::kAudioHardwarePropertyDefaultSystemOutputDevice,
    ]
    .into_iter()
    .map(|selector| register_coreaudio_listener(selector, sender.clone()))
    .collect()
}

fn register_coreaudio_listener(
    selector: ca::AudioObjectPropertySelector,
    sender: SyncSender<()>,
) -> Result<CoreAudioPropertyListener, String> {
    let address = ca::AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: ca::kAudioObjectPropertyScopeGlobal,
        mElement: ca::kAudioObjectPropertyElementMain,
    };
    let context = Box::into_raw(Box::new(sender));
    let status = unsafe {
        ca::AudioObjectAddPropertyListener(
            ca::kAudioObjectSystemObject,
            &address,
            Some(coreaudio_device_listener),
            context.cast(),
        )
    };
    if status != 0 {
        unsafe {
            drop(Box::from_raw(context));
        }
        return Err(format!(
            "failed to register CoreAudio device listener: {status}"
        ));
    }
    Ok(CoreAudioPropertyListener {
        object_id: ca::kAudioObjectSystemObject,
        address,
        context,
    })
}

extern "C" fn coreaudio_device_listener(
    _object_id: ca::AudioObjectID,
    _number_addresses: u32,
    _addresses: *const ca::AudioObjectPropertyAddress,
    context: *mut c_void,
) -> i32 {
    if context.is_null() {
        return 0;
    }
    let sender = unsafe { &*(context as *const SyncSender<()>) };
    let _ = sender.try_send(());
    0
}

fn all_audio_devices() -> Option<Vec<ca::AudioDeviceID>> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioHardwarePropertyDevices,
            mScope: ca::kAudioObjectPropertyScopeGlobal,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(
            ca::kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
        ) != 0
        {
            return None;
        }
        let count = size as usize / mem::size_of::<ca::AudioDeviceID>();
        let mut devices = vec![0 as ca::AudioDeviceID; count];
        if ca::AudioObjectGetPropertyData(
            ca::kAudioObjectSystemObject,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            devices.as_mut_ptr().cast(),
        ) != 0
        {
            return None;
        }
        Some(devices)
    }
}

fn has_output_streams(id: ca::AudioDeviceID) -> bool {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: ca::kAudioDevicePropertyStreamConfiguration,
            mScope: ca::kAudioDevicePropertyScopeOutput,
            mElement: ca::kAudioObjectPropertyElementWildcard,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(id, &address, 0, std::ptr::null(), &mut size) != 0
            || size == 0
        {
            return false;
        }
        let mut buffer = Vec::<u8>::with_capacity(size as usize);
        let list = buffer.as_mut_ptr().cast::<AudioBufferList>();
        if ca::AudioObjectGetPropertyData(id, &address, 0, std::ptr::null(), &mut size, list.cast())
            != 0
        {
            return false;
        }
        let buffers =
            std::slice::from_raw_parts((*list).mBuffers.as_ptr(), (*list).mNumberBuffers as usize);
        buffers.iter().any(|buffer| buffer.mNumberChannels > 0)
    }
}

fn device_name(id: ca::AudioDeviceID) -> Option<String> {
    property_cf_string_scoped(
        id,
        ca::kAudioDevicePropertyDeviceNameCFString,
        ca::kAudioDevicePropertyScopeOutput,
    )
    .or_else(|| {
        property_cf_string_scoped(
            id,
            ca::kAudioObjectPropertyName,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
    .or_else(|| {
        property_c_string_scoped(
            id,
            ca::kAudioObjectPropertyName,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
}

fn device_uid(id: ca::AudioDeviceID) -> Option<String> {
    property_cf_string_scoped(
        id,
        ca::kAudioDevicePropertyDeviceUID,
        ca::kAudioObjectPropertyScopeGlobal,
    )
    .or_else(|| {
        property_c_string_scoped(
            id,
            ca::kAudioDevicePropertyDeviceUID,
            ca::kAudioObjectPropertyScopeGlobal,
        )
    })
}

fn property_cf_string_scoped(
    id: ca::AudioDeviceID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
) -> Option<String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = mem::size_of::<CFStringRef>() as u32;
        let mut value: CFStringRef = std::ptr::null();
        if ca::AudioObjectGetPropertyData(
            id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut CFStringRef).cast(),
        ) != 0
            || value.is_null()
        {
            return None;
        }

        cf_string_to_string(value)
    }
}

fn cf_string_to_string(value: CFStringRef) -> Option<String> {
    unsafe {
        let mut buffer = vec![0i8; 1024];
        if CFStringGetCString(
            value,
            buffer.as_mut_ptr(),
            buffer.len() as CFIndex,
            K_CF_STRING_ENCODING_UTF8,
        ) == 0
        {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr())
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }
}

fn property_c_string_scoped(
    id: ca::AudioDeviceID,
    selector: ca::AudioObjectPropertySelector,
    scope: ca::AudioObjectPropertyScope,
) -> Option<String> {
    unsafe {
        let address = ca::AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: ca::kAudioObjectPropertyElementMain,
        };
        let mut size = 0u32;
        if ca::AudioObjectGetPropertyDataSize(id, &address, 0, std::ptr::null(), &mut size) != 0 {
            return None;
        }
        let mut buffer = vec![0u8; size as usize + 1];
        if ca::AudioObjectGetPropertyData(
            id,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            buffer.as_mut_ptr().cast(),
        ) != 0
        {
            return None;
        }
        CStr::from_ptr(buffer.as_ptr().cast())
            .to_str()
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    }
}
