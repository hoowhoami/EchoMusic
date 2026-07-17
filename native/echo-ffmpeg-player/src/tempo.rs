pub fn normalize_speed(value: f64) -> f32 {
    value.clamp(0.25, 4.0) as f32
}
