//! Keep decode, filter and WASAPI threads off Windows 11 EcoQoS.
//!
//! Snapdragon Windows parks EcoQoS threads on efficiency cores. Chromium
//! (Edge) opts the renderer out of that policy, so a browser video keeps
//! playing while EchoMusic's decode/filter workers starve and the WASAPI
//! callback underruns. Matching Chromium's opt-out, plus MMCSS "Audio" on
//! the producer threads, is the actual fix: enlarging the demuxer cache
//! does not help, because the ring is empty of decoded PCM, not of
//! network bytes.

const PROCESS_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
const THREAD_POWER_THROTTLING_CURRENT_VERSION: u32 = 1;
const PROCESS_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
const THREAD_POWER_THROTTLING_EXECUTION_SPEED: u32 = 0x1;
// PROCESS_INFORMATION_CLASS / THREAD_INFORMATION_CLASS ordinals from
// processthreadsapi.h. windows 0.58 does not always export these aliases.
const PROCESS_INFORMATION_PROCESS_POWER_THROTTLING: i32 = 4;
const THREAD_INFORMATION_THREAD_POWER_THROTTLING: i32 = 3;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PowerThrottlingState {
    version: u32,
    control_mask: u32,
    state_mask: u32,
}

fn disabled_execution_speed(version: u32, execution_speed_flag: u32) -> PowerThrottlingState {
    PowerThrottlingState {
        version,
        control_mask: execution_speed_flag,
        // StateMask 0 with the flag in ControlMask = "do not throttle".
        state_mask: 0,
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{
        disabled_execution_speed, PowerThrottlingState, PROCESS_INFORMATION_PROCESS_POWER_THROTTLING,
        PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        THREAD_INFORMATION_THREAD_POWER_THROTTLING, THREAD_POWER_THROTTLING_CURRENT_VERSION,
        THREAD_POWER_THROTTLING_EXECUTION_SPEED,
    };
    use std::ffi::c_void;
    use std::mem;
    use windows::core::PCSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Threading::{
        self, AVRT_PRIORITY, AVRT_PRIORITY_HIGH, AVRT_PRIORITY_NORMAL,
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn SetProcessInformation(
            hprocess: HANDLE,
            processinformationclass: i32,
            processinformation: *const c_void,
            processinformationsize: u32,
        ) -> i32;

        fn SetThreadInformation(
            hthread: HANDLE,
            threadinformationclass: i32,
            threadinformation: *const c_void,
            threadinformationsize: u32,
        ) -> i32;
    }

    pub fn opt_out_process_power_throttling() {
        let state = disabled_execution_speed(
            PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        );
        unsafe {
            let _ = SetProcessInformation(
                Threading::GetCurrentProcess(),
                PROCESS_INFORMATION_PROCESS_POWER_THROTTLING,
                std::ptr::addr_of!(state).cast(),
                mem::size_of::<PowerThrottlingState>() as u32,
            );
        }
    }

    fn opt_out_thread_power_throttling() {
        let state = disabled_execution_speed(
            THREAD_POWER_THROTTLING_CURRENT_VERSION,
            THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        );
        unsafe {
            let _ = SetThreadInformation(
                Threading::GetCurrentThread(),
                THREAD_INFORMATION_THREAD_POWER_THROTTLING,
                std::ptr::addr_of!(state).cast(),
                mem::size_of::<PowerThrottlingState>() as u32,
            );
        }
    }

    pub struct MultimediaTask {
        handle: HANDLE,
    }

    impl MultimediaTask {
        fn register(task_name: &[u8], priority: AVRT_PRIORITY) -> Result<Self, String> {
            let mut task_index = 0u32;
            let handle = unsafe {
                Threading::AvSetMmThreadCharacteristicsA(
                    PCSTR(task_name.as_ptr()),
                    &mut task_index,
                )
            }
            .map_err(|err| format!("failed to set MMCSS characteristics: {err}"))?;
            unsafe {
                Threading::AvSetMmThreadPriority(handle, priority).map_err(|err| {
                    let _ = Threading::AvRevertMmThreadCharacteristics(handle);
                    format!("failed to raise MMCSS priority: {err}")
                })?;
            }
            Ok(Self { handle })
        }
    }

    impl Drop for MultimediaTask {
        fn drop(&mut self) {
            unsafe {
                let _ = Threading::AvRevertMmThreadCharacteristics(self.handle);
            }
        }
    }

    pub fn boost_audio_output_thread() -> Result<MultimediaTask, String> {
        opt_out_thread_power_throttling();
        MultimediaTask::register(b"Pro Audio\0", AVRT_PRIORITY_HIGH)
    }

    pub fn boost_audio_producer_thread() -> Option<MultimediaTask> {
        opt_out_thread_power_throttling();
        MultimediaTask::register(b"Audio\0", AVRT_PRIORITY_NORMAL).ok()
    }
}

#[cfg(target_os = "windows")]
pub use windows_impl::{
    boost_audio_output_thread, boost_audio_producer_thread, opt_out_process_power_throttling,
    MultimediaTask,
};

#[cfg(not(target_os = "windows"))]
pub struct MultimediaTask;

#[cfg(not(target_os = "windows"))]
pub fn opt_out_process_power_throttling() {}

#[cfg(not(target_os = "windows"))]
pub fn boost_audio_producer_thread() -> Option<MultimediaTask> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn producer_boost_is_safe_on_this_platform() {
        opt_out_process_power_throttling();
        let _guard = boost_audio_producer_thread();
    }

    #[test]
    fn ecoqos_opt_out_clears_state_mask_and_keeps_control_flag() {
        let process = disabled_execution_speed(
            PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        );
        assert_eq!(process.version, 1);
        assert_eq!(process.control_mask, 0x1);
        assert_eq!(process.state_mask, 0);

        let thread = disabled_execution_speed(
            THREAD_POWER_THROTTLING_CURRENT_VERSION,
            THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        );
        assert_eq!(thread, process);
        assert_eq!(std::mem::size_of::<PowerThrottlingState>(), 12);
        assert_eq!(PROCESS_INFORMATION_PROCESS_POWER_THROTTLING, 4);
        assert_eq!(THREAD_INFORMATION_THREAD_POWER_THROTTLING, 3);
    }
}
