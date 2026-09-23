//! Application state management.

use airplay_core::Device;
use airplay_client::{PlaybackState, DeviceGroup, EqConfig, EqParams, StatsSnapshot, SpatialParams, SpatialMode};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Current view being displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum View {
    /// Device discovery and selection.
    #[default]
    Devices,
    /// File browser for selecting audio files.
    Browser,
    /// Now playing / playback controls.
    Player,
    /// USB audio input source.
    #[cfg(feature = "usb-audio")]
    UsbAudio,
    /// Bluetooth audio source (Linux only).
    #[cfg(feature = "bluetooth")]
    Bluetooth,
    /// Spatial audio placement for multi-speaker groups.
    Spatial,
}

impl View {
    /// Get the next view in the cycle.
    pub fn next(self) -> Self {
        let views = Self::all();
        let idx = views.iter().position(|v| *v == self).unwrap_or(0);
        views[(idx + 1) % views.len()]
    }

    /// Get the previous view in the cycle.
    pub fn prev(self) -> Self {
        let views = Self::all();
        let idx = views.iter().position(|v| *v == self).unwrap_or(0);
        views[(idx + views.len() - 1) % views.len()]
    }

    /// Get display name for the view.
    pub fn name(&self) -> &'static str {
        match self {
            View::Devices => "Devices",
            View::Browser => "Browser",
            View::Player => "Player",
            #[cfg(feature = "usb-audio")]
            View::UsbAudio => "USB Audio",
            #[cfg(feature = "bluetooth")]
            View::Bluetooth => "Bluetooth",
            View::Spatial => "Spatial",
        }
    }

    /// Get all views in order.
    pub fn all() -> Vec<View> {
        #[allow(unused_mut)]
        let mut views = vec![View::Devices, View::Browser, View::Player];
        #[cfg(feature = "usb-audio")]
        views.push(View::UsbAudio);
        #[cfg(feature = "bluetooth")]
        views.push(View::Bluetooth);
        views.push(View::Spatial);
        views
    }

    /// Get the index of this view in the tab bar.
    pub fn index(&self) -> usize {
        Self::all().iter().position(|v| v == self).unwrap_or(0)
    }
}

/// Status message with auto-dismiss.
#[derive(Debug, Clone)]
pub struct StatusMessage {
    pub text: String,
    pub is_error: bool,
    pub created_at: Instant,
    pub duration: Duration,
}

impl StatusMessage {
    pub fn info(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: false,
            created_at: Instant::now(),
            duration: Duration::from_secs(3),
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            is_error: true,
            created_at: Instant::now(),
            duration: Duration::from_secs(5),
        }
    }

    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= self.duration
    }
}

/// Discovered device with selection state.
#[derive(Debug, Clone)]
pub struct DeviceEntry {
    pub device: Device,
    pub is_connected: bool,
    pub is_selected: bool,
}

/// Main application state.
#[derive(Debug)]
pub struct AppState {
    /// Current view.
    pub view: View,
    /// Whether help overlay is shown.
    pub show_help: bool,
    /// Status message (auto-dismisses).
    pub status: Option<StatusMessage>,

    // Device state
    /// Discovered devices.
    pub devices: Vec<DeviceEntry>,
    /// Selected device index in list.
    pub device_index: usize,
    /// Whether device scan is in progress.
    pub scanning: bool,
    /// Whether a connection attempt is in progress.
    pub connecting: bool,
    /// Connected device (if any).
    pub connected_device: Option<Device>,

    // Playback state
    /// Current playback state.
    pub playback_state: PlaybackState,
    /// Current position in seconds.
    pub position: f64,
    /// Total duration in seconds.
    pub duration: Option<f64>,
    /// Current volume (0.0 to 1.0).
    pub volume: f32,
    /// Current file being played.
    pub current_file: Option<String>,

    // Group state
    /// Current device group.
    pub group: Option<DeviceGroupState>,
    /// Selected index in group member list.
    pub group_member_index: usize,

    // Stream stats
    /// Packet loss / retransmit statistics.
    pub stream_stats: StatsSnapshot,

    // Equalizer state
    /// Audio equalizer state.
    pub eq: EqState,

    // USB audio state
    #[cfg(feature = "usb-audio")]
    pub usb_audio: UsbAudioState,

    // Bluetooth state (Linux only)
    #[cfg(feature = "bluetooth")]
    pub bluetooth: BluetoothState,

    // Spatial audio state
    /// Spatial audio placement state.
    pub spatial: SpatialState,
}

/// Device group state for UI.
#[derive(Debug, Clone)]
pub struct DeviceGroupState {
    pub leader: Device,
    pub members: Vec<GroupMemberState>,
}

/// Equalizer state for UI.
#[derive(Debug)]
pub struct EqState {
    /// Shared EQ parameters (atomic updates for audio thread).
    pub params: Arc<EqParams>,
    /// EQ configuration (band frequencies and labels).
    pub config: EqConfig,
    /// Currently selected band index.
    pub selected_band: usize,
    /// Whether the EQ UI is expanded/visible.
    pub expanded: bool,
}

impl EqState {
    /// Create new EQ state with default 5-band configuration.
    pub fn new() -> Self {
        let config = EqConfig::five_band();
        let params = Arc::new(EqParams::new(config.num_bands()));
        Self {
            params,
            config,
            selected_band: 0,
            expanded: false,
        }
    }

    /// Create EQ state with a specific configuration.
    pub fn with_config(config: EqConfig) -> Self {
        let params = Arc::new(EqParams::new(config.num_bands()));
        Self {
            params,
            config,
            selected_band: 0,
            expanded: false,
        }
    }

    /// Get a clone of the shared params Arc for passing to the audio thread.
    pub fn params_arc(&self) -> Arc<EqParams> {
        Arc::clone(&self.params)
    }

    /// Select the previous band.
    pub fn select_prev_band(&mut self) {
        if self.selected_band > 0 {
            self.selected_band -= 1;
        }
    }

    /// Select the next band.
    pub fn select_next_band(&mut self) {
        if self.selected_band < self.config.num_bands() - 1 {
            self.selected_band += 1;
        }
    }

    /// Increase gain for the selected band by 1 dB.
    pub fn increase_gain(&self) {
        self.params.adjust_gain_db(self.selected_band, 1.0);
    }

    /// Decrease gain for the selected band by 1 dB.
    pub fn decrease_gain(&self) {
        self.params.adjust_gain_db(self.selected_band, -1.0);
    }

    /// Toggle EQ bypass.
    pub fn toggle_bypass(&self) {
        self.params.toggle_bypass();
    }

    /// Reset all bands to flat (0 dB).
    pub fn reset(&self) {
        self.params.reset();
    }

    /// Toggle expanded state.
    pub fn toggle_expanded(&mut self) {
        self.expanded = !self.expanded;
    }

    /// Check if EQ is bypassed.
    pub fn is_bypassed(&self) -> bool {
        self.params.is_bypassed()
    }

    /// Get the gain for the selected band.
    pub fn selected_gain_db(&self) -> f32 {
        self.params.get_gain_db(self.selected_band)
    }

    /// Get all gains for display.
    pub fn all_gains_db(&self) -> Vec<f32> {
        self.params.get_all_gains_db()
    }

    /// Get the frequency label for a band.
    pub fn band_label(&self, band: usize) -> &str {
        self.config.labels.get(band).map(|s| s.as_str()).unwrap_or("")
    }

    /// Get the frequency in Hz for a band.
    pub fn band_freq(&self, band: usize) -> f32 {
        *self.config.frequencies.get(band).unwrap_or(&0.0)
    }

    /// Format frequency as a display string.
    pub fn format_freq(freq: f32) -> String {
        if freq >= 1000.0 {
            format!("{:.0}kHz", freq / 1000.0)
        } else {
            format!("{:.0}Hz", freq)
        }
    }
}

impl Default for EqState {
    fn default() -> Self {
        Self::new()
    }
}

/// Spatial audio state for UI.
#[derive(Debug)]
pub struct SpatialState {
    /// Whether spatial processing is enabled.
    pub enabled: bool,
    /// Current spatial mode.
    pub mode: SpatialMode,
    /// Speaker entries with positions.
    pub speakers: Vec<SpatialSpeakerEntry>,
    /// Listener position in meters.
    pub listener_pos: (f64, f64),
    /// Listener facing angle in radians.
    pub listener_facing: f64,
    /// Currently selected index (0..N-1 = speakers, N = listener).
    pub selected_index: usize,
    /// Shared spatial params for the audio thread.
    pub params: Option<Arc<SpatialParams>>,
    /// Room width in meters.
    pub room_width: f64,
    /// Room height in meters.
    pub room_height: f64,
    /// Whether fine movement mode is active (Shift held).
    pub fine_mode: bool,
}

/// Speaker entry for the spatial UI.
#[derive(Debug, Clone)]
pub struct SpatialSpeakerEntry {
    pub device_id: String,
    pub device_name: String,
    pub position: (f64, f64),
}

impl SpatialState {
    /// Create new spatial state with defaults.
    pub fn new() -> Self {
        Self {
            enabled: false,
            mode: SpatialMode::StereoPan,
            speakers: Vec::new(),
            listener_pos: (0.0, 0.0),
            listener_facing: std::f64::consts::FRAC_PI_2, // facing +Y
            selected_index: 0,
            params: None,
            room_width: 8.0,
            room_height: 6.0,
            fine_mode: false,
        }
    }

    /// Total number of selectable items (speakers + listener).
    pub fn item_count(&self) -> usize {
        self.speakers.len() + 1
    }

    /// Whether the listener is currently selected.
    pub fn is_listener_selected(&self) -> bool {
        self.selected_index == self.speakers.len()
    }

    /// Get the movement step size in meters.
    pub fn step_size(&self) -> f64 {
        if self.fine_mode { 0.05 } else { 0.25 }
    }

    /// Select next item (cycles through speakers then listener).
    pub fn select_next(&mut self) {
        self.selected_index = (self.selected_index + 1) % self.item_count();
    }

    /// Select previous item.
    pub fn select_prev(&mut self) {
        if self.selected_index == 0 {
            self.selected_index = self.item_count() - 1;
        } else {
            self.selected_index -= 1;
        }
    }

    /// Move the selected item by the given delta.
    pub fn move_selected(&mut self, dx: f64, dy: f64) {
        if self.is_listener_selected() {
            self.listener_pos.0 = (self.listener_pos.0 + dx).clamp(-self.room_width / 2.0, self.room_width / 2.0);
            self.listener_pos.1 = (self.listener_pos.1 + dy).clamp(-self.room_height / 2.0, self.room_height / 2.0);
            if let Some(ref params) = self.params {
                params.set_listener(self.listener_pos.0, self.listener_pos.1, self.listener_facing);
            }
        } else if let Some(speaker) = self.speakers.get_mut(self.selected_index) {
            speaker.position.0 = (speaker.position.0 + dx).clamp(-self.room_width / 2.0, self.room_width / 2.0);
            speaker.position.1 = (speaker.position.1 + dy).clamp(-self.room_height / 2.0, self.room_height / 2.0);
            if let Some(ref params) = self.params {
                params.set_speaker_position(self.selected_index, speaker.position.0, speaker.position.1);
            }
        }
    }

    /// Toggle spatial enabled state.
    pub fn toggle_enabled(&mut self) {
        self.enabled = !self.enabled;
        if let Some(ref params) = self.params {
            params.toggle_enabled();
        }
    }

    /// Cycle between spatial modes.
    pub fn cycle_mode(&mut self) {
        self.mode = match self.mode {
            SpatialMode::StereoPan => SpatialMode::Stft51,
            SpatialMode::Stft51 => SpatialMode::StereoPan,
        };
        if let Some(ref params) = self.params {
            params.cycle_mode();
        }
    }

    /// Reset layout to default semicircle arrangement.
    pub fn reset_layout(&mut self) {
        let n = self.speakers.len();
        if n == 0 { return; }

        self.listener_pos = (0.0, 0.0);
        self.listener_facing = std::f64::consts::FRAC_PI_2;

        let radius = 2.0;
        for (i, speaker) in self.speakers.iter_mut().enumerate() {
            let angle = if n == 1 {
                std::f64::consts::FRAC_PI_2
            } else {
                // Spread from -90 to +90 degrees
                let t = i as f64 / (n - 1) as f64;
                std::f64::consts::PI * (0.25 + 0.5 * t) // 45° to 135°
            };
            speaker.position = (radius * angle.cos(), radius * angle.sin());
        }

        // Push positions to params
        if let Some(ref params) = self.params {
            params.set_listener(self.listener_pos.0, self.listener_pos.1, self.listener_facing);
            for (i, speaker) in self.speakers.iter().enumerate() {
                params.set_speaker_position(i, speaker.position.0, speaker.position.1);
            }
        }
    }

    /// Get distance from listener to selected speaker (if a speaker is selected).
    pub fn selected_distance(&self) -> Option<f64> {
        if self.is_listener_selected() { return None; }
        self.speakers.get(self.selected_index).map(|s| {
            let dx = s.position.0 - self.listener_pos.0;
            let dy = s.position.1 - self.listener_pos.1;
            (dx * dx + dy * dy).sqrt()
        })
    }
}

impl Default for SpatialState {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for SpatialState {
    fn clone(&self) -> Self {
        Self {
            enabled: self.enabled,
            mode: self.mode,
            speakers: self.speakers.clone(),
            listener_pos: self.listener_pos,
            listener_facing: self.listener_facing,
            selected_index: self.selected_index,
            params: self.params.as_ref().map(Arc::clone),
            room_width: self.room_width,
            room_height: self.room_height,
            fine_mode: self.fine_mode,
        }
    }
}

impl Clone for EqState {
    fn clone(&self) -> Self {
        Self {
            params: Arc::clone(&self.params),
            config: self.config.clone(),
            selected_band: self.selected_band,
            expanded: self.expanded,
        }
    }
}

/// Group member state for UI.
#[derive(Debug, Clone)]
pub struct GroupMemberState {
    pub device: Device,
    pub volume: f32,
    pub is_leader: bool,
}

/// USB audio input device entry for UI.
#[cfg(feature = "usb-audio")]
#[derive(Debug, Clone)]
pub struct UsbAudioDeviceEntry {
    /// Device name.
    pub name: String,
    /// Device index in cpal's enumeration.
    pub device_index: usize,
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Number of input channels.
    pub channels: u16,
}

/// USB audio input state for UI.
#[cfg(feature = "usb-audio")]
#[derive(Debug, Clone)]
pub struct UsbAudioState {
    /// Available input devices.
    pub devices: Vec<UsbAudioDeviceEntry>,
    /// Selected device index in list.
    pub device_index: usize,
    /// Currently selected device for capture.
    pub selected_device: Option<UsbAudioDeviceEntry>,
    /// Whether streaming audio from USB input.
    pub streaming: bool,
    /// Current audio level (RMS, 0.0-1.0).
    pub audio_level: f32,
    /// Total samples received.
    pub samples_received: u64,
}

#[cfg(feature = "usb-audio")]
impl Default for UsbAudioState {
    fn default() -> Self {
        Self {
            devices: Vec::new(),
            device_index: 0,
            selected_device: None,
            streaming: false,
            audio_level: 0.0,
            samples_received: 0,
        }
    }
}

#[cfg(feature = "usb-audio")]
impl UsbAudioState {
    /// Get selected device (if any) from the list.
    pub fn highlighted_device(&self) -> Option<&UsbAudioDeviceEntry> {
        self.devices.get(self.device_index)
    }

    /// Move selection up.
    pub fn select_prev(&mut self) {
        if !self.devices.is_empty() && self.device_index > 0 {
            self.device_index -= 1;
        }
    }

    /// Move selection down.
    pub fn select_next(&mut self) {
        if !self.devices.is_empty() && self.device_index < self.devices.len() - 1 {
            self.device_index += 1;
        }
    }
}

/// Bluetooth state for UI.
#[cfg(feature = "bluetooth")]
#[derive(Debug, Clone)]
pub struct BluetoothState {
    /// System setup status (BlueZ, BlueALSA).
    pub setup_checked: bool,
    /// Whether system is ready for Bluetooth.
    pub setup_ready: bool,
    /// Setup issues to display.
    pub setup_issues: Vec<String>,
    /// Whether Bluetooth adapter is powered.
    pub adapter_powered: bool,
    /// Adapter name (e.g., "hci0").
    pub adapter_name: Option<String>,
    /// Whether scanning for devices.
    pub scanning: bool,
    /// Discovered Bluetooth devices.
    pub devices: Vec<BluetoothDeviceEntry>,
    /// Selected device index.
    pub device_index: usize,
    /// Currently connected A2DP device.
    pub connected_device: Option<BluetoothDeviceEntry>,
    /// Whether streaming audio from Bluetooth.
    pub streaming: bool,
    /// Whether using Bluetooth as audio source for AirPlay.
    pub is_source_active: bool,
    /// Current audio level (RMS, 0.0-1.0).
    pub audio_level: f32,
    /// Total samples received.
    pub samples_received: u64,
}

/// Bluetooth device entry for UI.
#[cfg(feature = "bluetooth")]
#[derive(Debug, Clone)]
pub struct BluetoothDeviceEntry {
    /// Device address.
    pub address: String,
    /// Device name.
    pub name: String,
    /// Whether paired.
    pub paired: bool,
    /// Whether connected.
    pub connected: bool,
    /// Whether trusted.
    pub trusted: bool,
    /// Whether supports A2DP audio source.
    pub supports_a2dp: bool,
    /// Signal strength (RSSI).
    pub rssi: Option<i16>,
}

#[cfg(feature = "bluetooth")]
impl Default for BluetoothState {
    fn default() -> Self {
        Self {
            setup_checked: false,
            setup_ready: false,
            setup_issues: Vec::new(),
            adapter_powered: false,
            adapter_name: None,
            scanning: false,
            devices: Vec::new(),
            device_index: 0,
            connected_device: None,
            streaming: false,
            is_source_active: false,
            audio_level: 0.0,
            samples_received: 0,
        }
    }
}

#[cfg(feature = "bluetooth")]
impl BluetoothState {
    /// Get selected device (if any).
    pub fn selected_device(&self) -> Option<&BluetoothDeviceEntry> {
        self.devices.get(self.device_index)
    }

    /// Move selection up.
    pub fn select_prev(&mut self) {
        if !self.devices.is_empty() && self.device_index > 0 {
            self.device_index -= 1;
        }
    }

    /// Move selection down.
    pub fn select_next(&mut self) {
        if !self.devices.is_empty() && self.device_index < self.devices.len() - 1 {
            self.device_index += 1;
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            view: View::default(),
            show_help: false,
            status: None,
            devices: Vec::new(),
            device_index: 0,
            scanning: false,
            connecting: false,
            connected_device: None,
            playback_state: PlaybackState::Stopped,
            position: 0.0,
            duration: None,
            volume: 1.0,
            current_file: None,
            group: None,
            group_member_index: 0,
            stream_stats: StatsSnapshot::default(),
            eq: EqState::default(),
            #[cfg(feature = "usb-audio")]
            usb_audio: UsbAudioState::default(),
            #[cfg(feature = "bluetooth")]
            bluetooth: BluetoothState::default(),
            spatial: SpatialState::default(),
        }
    }
}

impl AppState {
    /// Create new application state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Set status message.
    pub fn set_status(&mut self, msg: StatusMessage) {
        self.status = Some(msg);
    }

    /// Clear expired status message.
    pub fn clear_expired_status(&mut self) {
        if let Some(ref status) = self.status {
            if status.is_expired() {
                self.status = None;
            }
        }
    }

    /// Get selected device (if any).
    pub fn selected_device(&self) -> Option<&Device> {
        self.devices.get(self.device_index).map(|e| &e.device)
    }

    /// Move selection up in current list.
    pub fn select_prev(&mut self) {
        match self.view {
            View::Devices => {
                if !self.devices.is_empty() && self.device_index > 0 {
                    self.device_index -= 1;
                }
            }
            #[cfg(feature = "usb-audio")]
            View::UsbAudio => {
                self.usb_audio.select_prev();
            }
            #[cfg(feature = "bluetooth")]
            View::Bluetooth => {
                self.bluetooth.select_prev();
            }
            _ => {}
        }
    }

    /// Move selection down in current list.
    pub fn select_next(&mut self) {
        match self.view {
            View::Devices => {
                if !self.devices.is_empty() && self.device_index < self.devices.len() - 1 {
                    self.device_index += 1;
                }
            }
            #[cfg(feature = "usb-audio")]
            View::UsbAudio => {
                self.usb_audio.select_next();
            }
            #[cfg(feature = "bluetooth")]
            View::Bluetooth => {
                self.bluetooth.select_next();
            }
            _ => {}
        }
    }

    /// Update group state from client group.
    pub fn update_group(&mut self, group: Option<&DeviceGroup>) {
        self.group = group.map(|g| {
            DeviceGroupState {
                leader: g.leader().device.clone(),
                members: g.members().map(|m| GroupMemberState {
                    device: m.device.clone(),
                    volume: m.volume,
                    is_leader: m.is_leader,
                }).collect(),
            }
        });
    }
}
