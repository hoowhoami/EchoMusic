use crate::error::PlayerResult;
use crate::types::AudioDevice;
use cpal::traits::{DeviceTrait, HostTrait};
use std::collections::HashSet;

const CPAL_DEVICE_PREFIX: &str = "cpal";

#[derive(Clone)]
struct PlatformOutputDevice {
    name: String,
    description: String,
}

pub fn list_output_devices() -> PlayerResult<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let mut devices = vec![AudioDevice {
        name: "auto".to_string(),
        description: "System default output".to_string(),
    }];
    let platform_devices = platform_output_devices();
    let mut known_output_labels: HashSet<String> = platform_devices
        .iter()
        .map(|device| device.description.clone())
        .collect();
    if let Some(default_label) = host
        .default_output_device()
        .and_then(|device| device.name().ok())
    {
        known_output_labels.insert(default_label);
    }

    let all_devices = match host.devices() {
        Ok(devices) => devices,
        Err(err) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("failed to enumerate audio devices, using default only: {err}"),
            ));
            return Ok(devices);
        }
    };

    let mut seen_labels = HashSet::new();
    for (index, device) in all_devices.enumerate() {
        let label = device
            .name()
            .unwrap_or_else(|_| format!("Audio Device {}", index + 1));
        if seen_labels.contains(&label)
            || !is_output_candidate(&device, &label, &known_output_labels)
        {
            continue;
        }
        devices.push(AudioDevice {
            name: cpal_device_name(index, &label),
            description: label.clone(),
        });
        seen_labels.insert(label);
    }

    append_platform_output_devices(&mut devices, platform_devices);
    Ok(devices)
}

pub fn platform_device_label(device_name: &str) -> Option<String> {
    platform_device_label_impl(device_name)
}

fn cpal_device_name(index: usize, label: &str) -> String {
    format!(
        "{CPAL_DEVICE_PREFIX}/{index}/{}",
        sanitize_device_label(label)
    )
}

pub(crate) fn sanitize_device_label(label: &str) -> String {
    let mut output = String::with_capacity(label.len());
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            output.push(ch);
        } else {
            output.push('_');
        }
    }
    output.trim_matches('_').to_string()
}

fn is_output_candidate(
    device: &cpal::Device,
    label: &str,
    known_output_labels: &HashSet<String>,
) -> bool {
    if known_output_labels.contains(label) {
        return true;
    }
    if device.default_output_config().is_ok() {
        return true;
    }
    device
        .supported_output_configs()
        .map(|mut configs| configs.next().is_some())
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn platform_output_devices() -> Vec<PlatformOutputDevice> {
    Vec::new()
}

#[cfg(not(target_os = "macos"))]
fn append_platform_output_devices(
    _devices: &mut Vec<AudioDevice>,
    _platform_devices: Vec<PlatformOutputDevice>,
) {
}

#[cfg(not(target_os = "macos"))]
fn platform_device_label_impl(_device_name: &str) -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn platform_output_devices() -> Vec<PlatformOutputDevice> {
    match macos_coreaudio_output_devices() {
        Ok(coreaudio_devices) => coreaudio_devices
            .into_iter()
            .map(|(id, label)| PlatformOutputDevice {
                name: format!("coreaudio/{id}/{}", sanitize_device_label(&label)),
                description: label,
            })
            .collect(),
        Err(reason) => {
            crate::emit_event(crate::log::event(
                crate::log::LogLevel::Warn,
                format!("CoreAudio output device enumeration failed: {reason}"),
            ));
            Vec::new()
        }
    }
}

#[cfg(target_os = "macos")]
fn append_platform_output_devices(
    devices: &mut Vec<AudioDevice>,
    platform_devices: Vec<PlatformOutputDevice>,
) {
    for platform_device in platform_devices {
        if devices
            .iter()
            .any(|device| device.description == platform_device.description)
        {
            continue;
        }
        devices.push(AudioDevice {
            name: platform_device.name,
            description: platform_device.description,
        });
    }
}

#[cfg(target_os = "macos")]
fn platform_device_label_impl(device_name: &str) -> Option<String> {
    let id = device_name
        .strip_prefix("coreaudio/")?
        .split('/')
        .next()?
        .parse::<u32>()
        .ok()?;
    macos_coreaudio_device_name(id).ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_coreaudio_output_devices() -> Result<Vec<(u32, String)>, String> {
    use coreaudio::sys::{
        kAudioHardwareNoError, kAudioHardwarePropertyDevices, kAudioObjectPropertyElementMaster,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, AudioDeviceID,
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    };
    use std::mem;
    use std::ptr::null;

    unsafe {
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMaster,
        };

        let mut data_size = 0u32;
        let status = AudioObjectGetPropertyDataSize(
            kAudioObjectSystemObject,
            &property_address,
            0,
            null(),
            &mut data_size,
        );
        if status != kAudioHardwareNoError as i32 {
            return Err(format!("AudioObjectGetPropertyDataSize status={status}"));
        }

        let count = data_size as usize / mem::size_of::<AudioDeviceID>();
        let mut ids = vec![0 as AudioDeviceID; count];
        let status = AudioObjectGetPropertyData(
            kAudioObjectSystemObject,
            &property_address,
            0,
            null(),
            &mut data_size,
            ids.as_mut_ptr().cast(),
        );
        if status != kAudioHardwareNoError as i32 {
            return Err(format!("AudioObjectGetPropertyData status={status}"));
        }

        let mut devices = Vec::new();
        for id in ids {
            if macos_coreaudio_output_channel_count(id).unwrap_or_default() == 0 {
                continue;
            }
            if let Ok(name) = macos_coreaudio_device_name(id) {
                devices.push((id, name));
            }
        }
        Ok(devices)
    }
}

#[cfg(target_os = "macos")]
fn macos_coreaudio_output_channel_count(id: u32) -> Result<u32, String> {
    use coreaudio::sys::{
        kAudioDevicePropertyScopeOutput, kAudioDevicePropertyStreamConfiguration,
        kAudioHardwareNoError, kAudioObjectPropertyElementMaster, AudioBufferList,
        AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectPropertyAddress,
    };
    use std::mem;
    use std::ptr::null;

    unsafe {
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut data_size = 0u32;
        let status =
            AudioObjectGetPropertyDataSize(id, &property_address, 0, null(), &mut data_size);
        if status != kAudioHardwareNoError as i32 {
            return Err(format!("stream config size status={status}"));
        }
        if data_size < mem::size_of::<AudioBufferList>() as u32 {
            return Ok(0);
        }

        let mut data = vec![0u8; data_size as usize];
        let status = AudioObjectGetPropertyData(
            id,
            &property_address,
            0,
            null(),
            &mut data_size,
            data.as_mut_ptr().cast(),
        );
        if status != kAudioHardwareNoError as i32 {
            return Err(format!("stream config data status={status}"));
        }

        let list = data.as_ptr().cast::<AudioBufferList>();
        let buffer_count = (*list).mNumberBuffers as usize;
        let first = (*list).mBuffers.as_ptr();
        let buffers = std::slice::from_raw_parts(first, buffer_count);
        Ok(buffers.iter().map(|buffer| buffer.mNumberChannels).sum())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn macos_coreaudio_device_name(id: u32) -> Result<String, String> {
    use core_foundation_sys::base::{CFRelease, CFTypeRef};
    use core_foundation_sys::string::{
        kCFStringEncodingUTF8, CFStringGetCString, CFStringGetCStringPtr, CFStringRef,
    };
    use coreaudio::sys::{
        kAudioDevicePropertyDeviceNameCFString, kAudioDevicePropertyScopeOutput,
        kAudioHardwareNoError, kAudioObjectPropertyElementMaster, AudioObjectGetPropertyData,
        AudioObjectPropertyAddress,
    };
    use std::ffi::CStr;
    use std::mem;
    use std::os::raw::c_char;
    use std::ptr::null;

    unsafe {
        let property_address = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMaster,
        };
        let mut device_name: CFStringRef = null();
        let mut data_size = mem::size_of::<CFStringRef>() as u32;
        let status = AudioObjectGetPropertyData(
            id,
            &property_address,
            0,
            null(),
            &mut data_size,
            (&mut device_name as *mut CFStringRef).cast(),
        );
        if status != kAudioHardwareNoError as i32 || device_name.is_null() {
            return Err(format!("device name status={status}"));
        }

        let c_string = CFStringGetCStringPtr(device_name, kCFStringEncodingUTF8);
        if !c_string.is_null() {
            let name = CStr::from_ptr(c_string).to_string_lossy().into_owned();
            CFRelease(device_name as CFTypeRef);
            return Ok(name);
        }

        let mut buffer = vec![0 as c_char; 512];
        let ok = CFStringGetCString(
            device_name,
            buffer.as_mut_ptr(),
            buffer.len() as isize,
            kCFStringEncodingUTF8,
        );
        if ok == 0 {
            CFRelease(device_name as CFTypeRef);
            return Err("CFStringGetCString failed".to_string());
        }
        let name = CStr::from_ptr(buffer.as_ptr())
            .to_string_lossy()
            .into_owned();
        CFRelease(device_name as CFTypeRef);
        Ok(name)
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_device_label;

    #[test]
    fn device_label_sanitizer_keeps_ids_ascii_safe() {
        assert_eq!(
            sanitize_device_label("MacBook Pro Speakers"),
            "MacBook_Pro_Speakers"
        );
        assert_eq!(sanitize_device_label("USB/DAC: 2ch"), "USB_DAC__2ch");
    }
}
