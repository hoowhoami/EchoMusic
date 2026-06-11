use super::eq::build_eq_filter;
use super::spatial::{build_spatial_filter, SpatialAudioConfig};

#[derive(Default, Clone)]
pub struct AudioFilterChain {
    pub normalization_gain: Option<f64>,
    pub eq_gains: Option<Vec<f64>>,
    pub spatial_config: Option<SpatialAudioConfig>,
    pub custom_filters: Vec<String>,
}

impl AudioFilterChain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build(&self) -> Result<String, String> {
        let mut filters = Vec::new();

        if let Some(gain) = self.normalization_gain {
            if gain.abs() > 0.01 {
                filters.push(format!("volume={}dB", gain));
            }
        }

        if let Some(ref gains) = self.eq_gains {
            filters.push(build_eq_filter(gains, true));
        }

        if let Some(ref config) = self.spatial_config {
            filters.push(build_spatial_filter(config)?);
        }

        filters.extend(self.custom_filters.iter().cloned());

        if filters.is_empty() {
            Ok(String::new())
        } else {
            Ok(filters.join(","))
        }
    }

    pub fn clear_eq(&mut self) {
        self.eq_gains = None;
    }

    pub fn clear_spatial(&mut self) {
        self.spatial_config = None;
    }

    pub fn clear_all(&mut self) {
        self.normalization_gain = None;
        self.eq_gains = None;
        self.spatial_config = None;
        self.custom_filters.clear();
    }
}
