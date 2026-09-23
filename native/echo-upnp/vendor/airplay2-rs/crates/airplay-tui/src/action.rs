//! Action types for the TUI application.

use airplay_core::Device;
use airplay_client::PlaybackState;
use std::path::PathBuf;

/// Actions that can be dispatched to update state.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Action {
    // Navigation
    /// Quit the application.
    Quit,
    /// Toggle help overlay.
    ToggleHelp,
    /// Switch to next view.
    NextView,
    /// Go back / escape.
    Back,
    /// Move selection up.
    SelectPrev,
    /// Move selection down.
    SelectNext,
    /// Activate selected item.
    Select,

    // Device actions
    /// Start device scan.
    ScanDevices,
    /// Device scan completed with results.
    DevicesScanned(Vec<Device>),
    /// Connect to selected device.
    Connect,
    /// Connect completed.
    Connected(Device),
    /// Disconnect from device.
    Disconnect,
    /// Disconnected from device.
    Disconnected,
    /// Connection/operation failed.
    Error(String),

    // Playback actions
    /// Play/pause toggle.
    PlayPause,
    /// Stop playback.
    Stop,
    /// Seek forward by seconds.
    SeekForward(f64),
    /// Seek backward by seconds.
    SeekBackward(f64),
    /// Increase volume.
    VolumeUp,
    /// Decrease volume.
    VolumeDown,
    /// Set volume to specific value.
    SetVolume(f32),
    /// Playback state changed.
    PlaybackStateChanged(PlaybackState),
    /// Playback started successfully.
    PlaybackStarted,
    /// Position updated.
    PositionUpdated(f64),
    /// Play a file.
    PlayFile(PathBuf),

    // Group actions
    /// Create group from connected device and selected devices.
    CreateGroup,
    /// Add selected device to group.
    AddToGroup,
    /// Remove selected device from group.
    RemoveFromGroup,
    /// Disband current group.
    DisbandGroup,
    /// Group changed.
    GroupChanged,
    /// Toggle device selection for group (Space key in Devices view).
    ToggleDeviceSelect,
    /// Connect to all selected devices as a synchronized group.
    ConnectGroup,
    /// Group connection completed.
    GroupConnected { device_count: usize },
    /// Play file to all group devices simultaneously.
    PlayFileToGroup(PathBuf),

    // File browser actions
    /// Navigate to directory.
    NavigateDir(PathBuf),
    /// File selected.
    FileSelected(PathBuf),

    // Status
    /// Show status message.
    ShowStatus(String),
    /// Show error message.
    ShowError(String),
    /// Clear status message.
    ClearStatus,
    /// Tick for periodic updates.
    Tick,

    // Equalizer actions
    /// Select previous EQ band.
    EqSelectPrevBand,
    /// Select next EQ band.
    EqSelectNextBand,
    /// Increase gain for selected band (+1 dB).
    EqIncreaseGain,
    /// Decrease gain for selected band (-1 dB).
    EqDecreaseGain,
    /// Toggle EQ bypass.
    EqToggleBypass,
    /// Toggle EQ expanded view.
    EqToggleExpanded,
    /// Reset all EQ bands to flat.
    EqReset,

    // Bluetooth actions (Linux only)
    #[cfg(feature = "bluetooth")]
    /// Check Bluetooth system setup.
    BluetoothCheckSetup,
    #[cfg(feature = "bluetooth")]
    /// Attempt automatic Bluetooth setup.
    BluetoothAutoInstall,
    #[cfg(feature = "bluetooth")]
    /// Initialize Bluetooth adapter.
    BluetoothInitAdapter,
    #[cfg(feature = "bluetooth")]
    /// Adapter initialized successfully.
    BluetoothAdapterReady { name: String, powered: bool },
    #[cfg(feature = "bluetooth")]
    /// Scan for Bluetooth devices.
    BluetoothScan,
    #[cfg(feature = "bluetooth")]
    /// Scan completed with devices.
    BluetoothDevicesScanned(Vec<crate::state::BluetoothDeviceEntry>),
    #[cfg(feature = "bluetooth")]
    /// Pair with selected device.
    BluetoothPair,
    #[cfg(feature = "bluetooth")]
    /// Connect to selected device.
    BluetoothConnect,
    #[cfg(feature = "bluetooth")]
    /// Device connected.
    BluetoothConnected(crate::state::BluetoothDeviceEntry),
    #[cfg(feature = "bluetooth")]
    /// Disconnect from Bluetooth device.
    BluetoothDisconnect,
    #[cfg(feature = "bluetooth")]
    /// Device disconnected.
    BluetoothDisconnected,
    #[cfg(feature = "bluetooth")]
    /// Start using Bluetooth as audio source for AirPlay.
    BluetoothStartSource,
    #[cfg(feature = "bluetooth")]
    /// Stop using Bluetooth as audio source.
    BluetoothStopSource,
    #[cfg(feature = "bluetooth")]
    /// Update audio level meter.
    BluetoothAudioLevel { level: f32, samples: u64 },
    #[cfg(feature = "bluetooth")]
    /// Update streaming status.
    BluetoothStreamingStatus(bool),
    #[cfg(feature = "bluetooth")]
    /// Toggle Bluetooth adapter power on/off.
    BluetoothTogglePower,
    #[cfg(feature = "bluetooth")]
    /// Bluetooth error occurred.
    BluetoothError(String),

    // Spatial audio actions
    /// Move selected speaker/listener up (+Y).
    SpatialMoveUp,
    /// Move selected speaker/listener down (-Y).
    SpatialMoveDown,
    /// Move selected speaker/listener left (-X).
    SpatialMoveLeft,
    /// Move selected speaker/listener right (+X).
    SpatialMoveRight,
    /// Select next speaker/listener.
    SpatialSelectNext,
    /// Select previous speaker/listener.
    SpatialSelectPrev,
    /// Toggle spatial processing on/off.
    SpatialToggleEnabled,
    /// Cycle spatial mode (StereoPan <-> Stft51).
    SpatialCycleMode,
    /// Reset layout to default semicircle.
    SpatialResetLayout,
    /// Toggle fine movement mode.
    SpatialFineToggle,

    // USB Audio actions
    #[cfg(feature = "usb-audio")]
    /// Refresh USB audio input device list.
    UsbAudioRefreshDevices,
    #[cfg(feature = "usb-audio")]
    /// USB audio devices enumerated.
    UsbAudioDevicesListed(Vec<crate::state::UsbAudioDeviceEntry>),
    #[cfg(feature = "usb-audio")]
    /// Select the highlighted USB audio device.
    UsbAudioSelectDevice,
    #[cfg(feature = "usb-audio")]
    /// Start USB audio capture and AirPlay streaming.
    UsbAudioStartSource,
    #[cfg(feature = "usb-audio")]
    /// Stop USB audio capture.
    UsbAudioStopSource,
    #[cfg(feature = "usb-audio")]
    /// Update audio level meter from capture thread.
    UsbAudioLevel { level: f32, samples: u64 },
    #[cfg(feature = "usb-audio")]
    /// USB audio error.
    UsbAudioError(String),
}
