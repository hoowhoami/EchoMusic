//! Spatial audio layout persistence.
//!
//! Saves and loads speaker/listener positions per group combination.
//! Layouts are stored as JSON files keyed by a hash of the sorted device IDs.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use crate::state::SpatialState;
use airplay_client::SpatialMode;

/// Serializable spatial layout.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpatialLayout {
    pub speakers: Vec<SpatialSpeakerLayout>,
    pub listener: ListenerLayout,
    pub room_width: f64,
    pub room_height: f64,
    pub mode: String,
}

/// Speaker position in a saved layout.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpatialSpeakerLayout {
    pub device_id: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
}

/// Listener position in a saved layout.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ListenerLayout {
    pub x: f64,
    pub y: f64,
    pub facing: f64,
}

/// Generate a group key from device IDs.
fn group_key(device_ids: &[&str]) -> String {
    let mut sorted: Vec<&str> = device_ids.to_vec();
    sorted.sort();
    sorted.join("+")
}

/// Hash the group key for filename.
fn group_key_hash(key: &str) -> String {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    let hash = hasher.finish();
    format!("{:016x}", hash)[..8].to_string()
}

/// Get the layout file path for a group.
fn layout_path(device_ids: &[&str]) -> PathBuf {
    let key = group_key(device_ids);
    let hash = group_key_hash(&key);
    // Store in current working directory alongside identity files
    PathBuf::from(format!(".airplay_spatial_layout_{}.json", hash))
}

/// Load a saved spatial layout for the given group of device IDs.
pub fn load_for_group(device_ids: &[&str]) -> Option<SpatialLayout> {
    let path = layout_path(device_ids);
    let data = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&data).ok()
}

/// Save a spatial layout for the given group of device IDs.
pub fn save_for_group(device_ids: &[&str], layout: &SpatialLayout) {
    let path = layout_path(device_ids);
    if let Ok(data) = serde_json::to_string_pretty(layout) {
        let _ = std::fs::write(&path, data);
    }
}

/// Convert SpatialState to a saveable layout.
pub fn state_to_layout(state: &SpatialState) -> SpatialLayout {
    SpatialLayout {
        speakers: state.speakers.iter().map(|s| SpatialSpeakerLayout {
            device_id: s.device_id.clone(),
            name: s.device_name.clone(),
            x: s.position.0,
            y: s.position.1,
        }).collect(),
        listener: ListenerLayout {
            x: state.listener_pos.0,
            y: state.listener_pos.1,
            facing: state.listener_facing,
        },
        room_width: state.room_width,
        room_height: state.room_height,
        mode: match state.mode {
            SpatialMode::StereoPan => "stereo_pan".to_string(),
            SpatialMode::Stft51 => "stft_51".to_string(),
        },
    }
}

/// Apply a saved layout to a SpatialState, matching speakers by device_id.
pub fn apply_layout(state: &mut SpatialState, layout: &SpatialLayout) {
    state.listener_pos = (layout.listener.x, layout.listener.y);
    state.listener_facing = layout.listener.facing;
    state.room_width = layout.room_width;
    state.room_height = layout.room_height;
    state.mode = match layout.mode.as_str() {
        "stft_51" => SpatialMode::Stft51,
        _ => SpatialMode::StereoPan,
    };

    // Match speakers by device_id
    for saved in &layout.speakers {
        if let Some(speaker) = state.speakers.iter_mut().find(|s| s.device_id == saved.device_id) {
            speaker.position = (saved.x, saved.y);
        }
    }

    // Push to params
    if let Some(ref params) = state.params {
        params.set_listener(state.listener_pos.0, state.listener_pos.1, state.listener_facing);
        for (i, speaker) in state.speakers.iter().enumerate() {
            params.set_speaker_position(i, speaker.position.0, speaker.position.1);
        }
    }
}
