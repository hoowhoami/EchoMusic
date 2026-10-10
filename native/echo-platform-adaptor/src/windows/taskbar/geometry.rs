//! 与 Win32 无关的尺寸约束，便于在任意开发平台验证。
pub fn fit_bitmap(width: u32, height: u32, max_width: u32, max_height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || width > 600 || height > 600 || max_width == 0 || max_height == 0
    {
        return None;
    }
    let ratio = (max_width.min(600) as f64 / width as f64)
        .min(max_height.min(600) as f64 / height as f64)
        .min(1.0);
    Some((
        ((width as f64 * ratio).floor() as u32).max(1),
        ((height as f64 * ratio).floor() as u32).max(1),
    ))
}

pub fn free_intervals(width: i32, mut occupied: Vec<(i32, i32)>) -> Vec<(i32, i32)> {
    if width <= 0 {
        return Vec::new();
    }
    occupied.retain(|(start, end)| end > start);
    occupied.sort_unstable();
    let mut cursor = 0;
    let mut gaps = Vec::new();
    for (start, end) in occupied {
        let start = start.saturating_sub(6).clamp(0, width);
        let end = end.saturating_add(6).clamp(0, width);
        if start > cursor {
            gaps.push((cursor, start - cursor));
        }
        cursor = cursor.max(end);
    }
    if cursor < width {
        gaps.push((cursor, width - cursor));
    }
    gaps
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn portrait_and_landscape_keep_their_aspect_ratio() {
        assert_eq!(fit_bitmap(512, 256, 230, 150), Some((230, 115)));
        assert_eq!(fit_bitmap(256, 512, 230, 150), Some((75, 150)));
        assert_eq!(fit_bitmap(512, 512, 320, 200), Some((200, 200)));
    }
    #[test]
    fn malformed_and_oversized_requests_cannot_allocate_large_bitmaps() {
        assert_eq!(fit_bitmap(0, 100, 200, 200), None);
        assert_eq!(fit_bitmap(100, 100, 0, 200), None);
        assert_eq!(fit_bitmap(u32::MAX, 100, 200, 200), None);
        assert_eq!(fit_bitmap(512, 512, u32::MAX, u32::MAX), Some((512, 512)));
        assert_eq!(fit_bitmap(1, 600, 1, 1), Some((1, 1)));
    }
    #[test]
    fn covers_are_never_upscaled() {
        assert_eq!(fit_bitmap(100, 50, 600, 600), Some((100, 50)));
    }
    #[test]
    fn overlapping_buttons_and_tray_do_not_leave_false_gaps() {
        assert_eq!(
            free_intervals(1920, vec![(1600, 1920), (700, 1000), (900, 1150), (0, 100)]),
            vec![(106, 588), (1156, 438)]
        );
    }
    #[test]
    fn out_of_bounds_and_reversed_intervals_are_safe() {
        assert_eq!(
            free_intervals(100, vec![(i32::MIN, 20), (70, i32::MAX), (90, 10)]),
            vec![(26, 38)]
        );
        assert!(free_intervals(100, vec![(0, 100)]).is_empty());
        assert!(free_intervals(0, vec![(1, 10)]).is_empty());
    }
}
