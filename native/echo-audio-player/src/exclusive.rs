pub struct ExclusiveGuard {
    release: Option<ExclusiveRelease>,
}

enum ExclusiveRelease {
    #[cfg(target_os = "macos")]
    CoreAudioHog { device_id: u32 },
}

impl ExclusiveGuard {
    pub(crate) fn noop() -> Self {
        Self { release: None }
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn coreaudio_hog(device_id: u32) -> Self {
        Self {
            release: Some(ExclusiveRelease::CoreAudioHog { device_id }),
        }
    }

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
                return Ok(Some(Self::noop()));
            }
            return Err("Linux exclusive output requires an ALSA hw:/plughw: device".to_string());
        }

        #[cfg(target_os = "windows")]
        {
            let _ = device_name;
            return Ok(Some(Self::noop()));
        }

        #[allow(unreachable_code)]
        Ok(Some(Self::noop()))
    }
}

impl Drop for ExclusiveGuard {
    fn drop(&mut self) {
        match self.release.take() {
            #[cfg(target_os = "macos")]
            Some(ExclusiveRelease::CoreAudioHog { device_id }) => {
                crate::device::platform_macos::release_exclusive(device_id);
            }
            None => {}
        }
    }
}
