pub struct EqPreset {
    pub name: &'static str,
    pub gains: [f64; 18],
}

pub const FREQS: [u32; 18] = [
    50, 80, 125, 200, 315, 500, 800, 1250, 2000, 3150,
    5000, 8000, 12500, 16000, 20000, 22000, 24000, 26000,
];

pub const PRESETS: &[EqPreset] = &[
    EqPreset { name: "flat", gains: [0.0; 18] },
    EqPreset {
        name: "pop",
        gains: [3.0, 2.5, 1.5, 0.5, -0.5, -1.0, -0.5, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 4.5, 3.5, 2.5, 1.5, 0.5],
    },
    EqPreset {
        name: "rock",
        gains: [5.0, 4.5, 3.5, 2.0, 0.0, -2.0, -3.0, -2.5, -1.0, 0.5, 2.0, 3.5, 4.5, 5.0, 5.5, 5.0, 4.0, 3.0],
    },
    EqPreset {
        name: "jazz",
        gains: [2.0, 1.5, 1.0, 0.5, 0.0, -0.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 2.0, 1.5, 1.0, 0.5],
    },
    EqPreset {
        name: "classical",
        gains: [1.0, 0.5, 0.0, -0.5, -1.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 2.0, 1.5, 1.0, 0.5],
    },
    EqPreset {
        name: "electronic",
        gains: [6.0, 5.5, 5.0, 4.0, 2.0, 0.0, -1.0, -2.0, -1.5, -0.5, 1.0, 2.5, 4.0, 5.0, 5.5, 5.0, 4.0, 3.0],
    },
];

pub fn build_eq_filter(gains: &[f64], auto_compensate: bool) -> String {
    let compensation = if auto_compensate {
        let positive_sum: f64 = gains.iter().filter(|&&g| g > 0.0).sum();
        -(positive_sum * 0.3).max(0.0)
    } else {
        0.0
    };

    let eq_parts: Vec<String> = gains
        .iter()
        .zip(FREQS.iter())
        .map(|(gain, freq)| format!("f={}:width_type=h:width=200:g={}", freq, gain))
        .collect();

    let mut filter = format!("superequalizer={}", eq_parts.join(":"));
    if compensation.abs() > 0.01 {
        filter.push_str(&format!(",volume={}dB", compensation));
    }
    filter
}

pub fn get_preset(name: &str) -> Option<&'static EqPreset> {
    PRESETS.iter().find(|p| p.name == name)
}
