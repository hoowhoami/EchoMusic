pub struct PeakFinder;

impl PeakFinder {
    pub fn detect_peak(data: &[f32], min_pos: usize, max_pos: usize) -> f64 {
        if data.is_empty() || min_pos >= max_pos || max_pos > data.len() {
            return 0.0;
        }

        // find absolute peak
        let mut peak_pos = min_pos;
        let mut peak = f64::from(data[min_pos]);
        for (i, value) in data.iter().enumerate().take(max_pos).skip(min_pos + 1) {
            if f64::from(*value) > peak {
                peak = f64::from(*value);
                peak_pos = i;
            }
        }

        // Calculate exact location of the highest peak mass center
        let high_peak = Self::get_peak_center(data, min_pos, max_pos, peak_pos);
        let mut peak_res = high_peak;

        // Check for harmonics
        for i in 1..3 {
            let harmonic = 2.0_f64.powi(i);
            let mut h_peak_pos = (high_peak / harmonic + 0.5) as usize;
            if h_peak_pos < min_pos {
                break;
            }
            h_peak_pos = Self::find_top(data, min_pos, max_pos, h_peak_pos);
            if h_peak_pos == 0 {
                continue;
            }

            let peaktmp = Self::get_peak_center(data, min_pos, max_pos, h_peak_pos);

            let diff = harmonic * peaktmp / high_peak;
            if !(0.96..=1.04).contains(&diff) {
                continue;
            }

            let i1 = (high_peak + 0.5) as usize;
            let i2 = (peaktmp + 0.5) as usize;
            if i1 < data.len() && i2 < data.len() && data[i2] >= 0.4 * data[i1] {
                peak_res = peaktmp;
            }
        }

        peak_res
    }

    fn get_peak_center(data: &[f32], min_pos: usize, max_pos: usize, peak_pos: usize) -> f64 {
        if peak_pos >= data.len() {
            return 0.0;
        }

        let gp1 = Self::find_ground(data, min_pos, max_pos, peak_pos, -1);
        let gp2 = Self::find_ground(data, min_pos, max_pos, peak_pos, 1);

        let peak_level = data[peak_pos];
        let cut_level = if gp1 != gp2 && gp1 < data.len() && gp2 < data.len() {
            let ground_level = f32::midpoint(data[gp1], data[gp2]);
            0.30f32.mul_add(ground_level, 0.70 * peak_level)
        } else {
            peak_level
        };

        let crosspos1 = Self::find_crossing_level(data, min_pos, max_pos, cut_level, peak_pos, -1);
        let crosspos2 = Self::find_crossing_level(data, min_pos, max_pos, cut_level, peak_pos, 1);

        if crosspos1.is_none() || crosspos2.is_none() {
            return 0.0;
        }

        Self::calc_mass_center(data, crosspos1.unwrap(), crosspos2.unwrap())
    }

    fn find_top(data: &[f32], min_pos: usize, max_pos: usize, peak_pos: usize) -> usize {
        if peak_pos >= data.len() {
            return 0;
        }

        let mut refvalue = data[peak_pos];
        let mut start = peak_pos.saturating_sub(10);
        if start < min_pos {
            start = min_pos;
        }
        let mut end = peak_pos.saturating_add(10);
        if end >= max_pos {
            end = max_pos.saturating_sub(1);
        }

        let mut local_peak_pos = peak_pos;
        for i in start..=end {
            if i < data.len() && data[i] > refvalue {
                local_peak_pos = i;
                refvalue = data[i];
            }
        }

        if local_peak_pos == start || local_peak_pos == end {
            return 0;
        }

        local_peak_pos
    }

    fn find_ground(
        data: &[f32],
        min_pos: usize,
        max_pos: usize,
        peak_pos: usize,
        direction: isize,
    ) -> usize {
        let mut climb_count: usize = 0;
        let mut lowpos = peak_pos;
        let mut refvalue = data.get(peak_pos).copied().unwrap_or(0.0);
        let mut pos = peak_pos;

        while pos > min_pos + 1 && pos < max_pos.saturating_sub(1) {
            let prev_pos = pos;
            if direction < 0 {
                pos = pos.saturating_sub(1);
            } else {
                pos = pos.saturating_add(1);
            }

            if pos >= data.len() {
                break;
            }

            let delta = data[pos] - data[prev_pos];
            if delta <= 0.0 {
                climb_count = climb_count.saturating_sub(1);
                if data[pos] < refvalue {
                    lowpos = pos;
                    refvalue = data[pos];
                }
            } else {
                climb_count += 1;
                if climb_count > 5 {
                    break;
                }
            }
        }
        lowpos
    }

    fn find_crossing_level(
        data: &[f32],
        min_pos: usize,
        max_pos: usize,
        level: f32,
        peak_pos: usize,
        direction: isize,
    ) -> Option<usize> {
        let mut pos = peak_pos;

        if direction < 0 {
            while pos >= min_pos {
                if pos == 0 {
                    break;
                }
                let next = pos - 1;
                if next < min_pos {
                    break;
                }
                if data[next] < level {
                    return Some(pos);
                }
                pos -= 1;
            }
        } else {
            while pos < max_pos {
                let next = pos + 1;
                if next >= max_pos || next >= data.len() {
                    break;
                }
                if data[next] < level {
                    return Some(pos);
                }
                pos += 1;
            }
        }

        None
    }

    fn calc_mass_center(data: &[f32], first_pos: usize, last_pos: usize) -> f64 {
        let mut sum = 0.0;
        let mut wsum = 0.0;

        for (i, &val) in data.iter().enumerate().take(last_pos + 1).skip(first_pos) {
            sum = (i as f64).mul_add(f64::from(val), sum);
            wsum += f64::from(val);
        }

        if wsum < 1e-6 {
            return 0.0;
        }
        sum / wsum
    }
}
