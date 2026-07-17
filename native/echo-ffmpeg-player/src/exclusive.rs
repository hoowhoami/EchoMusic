pub struct ExclusiveGuard;

impl ExclusiveGuard {
    pub fn acquire(device_name: &str) -> Result<Option<Self>, String> {
        #[cfg(target_os = "macos")]
        {
            return crate::device::platform_macos::acquire_exclusive(device_name);
        }

        #[cfg(target_os = "linux")]
        {
            if crate::device::platform_linux::is_alsa_hardware_pcm(device_name)
                || crate::device::is_default_device_name(device_name)
            {
                return Ok(Some(Self));
            }
            return Err("Linux exclusive output requires an ALSA hw:/plughw: device".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            let _ = device_name;
            return Ok(Some(Self));
        }

        #[allow(unreachable_code)]
        Ok(Some(Self))
    }
}
