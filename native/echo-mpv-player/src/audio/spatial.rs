use std::path::Path;

#[derive(Clone)]
pub struct SpatialAudioConfig {
    pub ir_path: String,
    pub wet_level: f64,
    pub normalize: bool,
}

impl Default for SpatialAudioConfig {
    fn default() -> Self {
        Self {
            ir_path: String::new(),
            wet_level: 0.5,
            normalize: true,
        }
    }
}

pub fn build_spatial_filter(config: &SpatialAudioConfig) -> Result<String, String> {
    if config.ir_path.is_empty() {
        return Err("IR path is empty".to_string());
    }

    if !Path::new(&config.ir_path).exists() {
        return Err(format!("IR file not found: {}", config.ir_path));
    }

    let dry_level = 1.0 - config.wet_level;
    let normalize = if config.normalize { 1 } else { 0 };

    let filter = format!(
        "asplit=2[dry][wet];[wet]aconvolve={}:normalize={}[conv];[dry][conv]amix=inputs=2:weights={} {}",
        config.ir_path, normalize, dry_level, config.wet_level
    );

    Ok(filter)
}
