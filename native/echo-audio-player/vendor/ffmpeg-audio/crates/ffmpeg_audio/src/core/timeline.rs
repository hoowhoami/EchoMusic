use std::time::Duration;

use crate::{AudioError, Result, sys};

const NANOS_PER_SEC: i128 = 1_000_000_000;

/// The timing FFmpeg reported for one decoded frame.
#[derive(Debug, Clone, Copy)]
pub struct FrameTiming {
    /// Raw timestamp of the frame's first sample, or `AV_NOPTS_VALUE` when it is missing.
    pub pts: i64,

    /// Number of samples per channel.
    pub samples: usize,

    /// Sample rate of this specific frame.
    pub sample_rate: i32,
}

/// Where a decoded frame lands on the public timeline once the samples before the requested
/// time have been trimmed away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FramePlacement {
    raw_pts: Option<i64>,
    pts: Option<Duration>,
    end: Option<Duration>,
    duration: Duration,
    offset: usize,
    samples: usize,
}

impl FramePlacement {
    /// Raw timestamp of the decoded frame, which identifies it within the stream.
    pub const fn raw_pts(&self) -> Option<i64> {
        self.raw_pts
    }

    /// Public time of the first delivered sample, or `None` for frames without a raw timestamp.
    pub const fn pts(&self) -> Option<Duration> {
        self.pts
    }

    /// Public time right after the frame's last sample, or `None` for frames without a raw
    /// timestamp.
    pub const fn end(&self) -> Option<Duration> {
        self.end
    }

    /// Playback duration of the delivered samples.
    pub const fn duration(&self) -> Duration {
        self.duration
    }

    /// Number of leading samples trimmed from the decoded frame.
    pub const fn offset(&self) -> usize {
        self.offset
    }

    /// Number of samples per channel that are delivered.
    pub const fn samples(&self) -> usize {
        self.samples
    }
}

/// The mapping between raw stream timestamps and the public timeline.
///
/// Every conversion is carried out with exact rational arithmetic and rounded exactly once:
/// sample positions are rounded up (to the first sample at or after the requested time), and
/// reported times are rounded down to whole nanoseconds. Seeking to a reported time therefore
/// lands on the same sample again.
#[derive(Debug, Clone, Copy)]
pub struct Timeline {
    /// Numerator of the stream time base, in seconds per raw tick.
    tb_num: i128,

    /// Denominator of the stream time base.
    tb_den: i128,

    /// Raw timestamp that corresponds to zero on the public timeline.
    origin: i64,
}

impl Timeline {
    /// Builds the timeline of a stream from its time base and declared start time.
    ///
    /// The origin is the declared start time. When the start time is negative or missing, the
    /// origin is raw zero, and everything before it is preroll.
    pub fn new(time_base: sys::AVRational, start_time: i64) -> Result<Self> {
        if time_base.num <= 0 || time_base.den <= 0 {
            return Err(AudioError::InvalidParameter(format!(
                "Invalid stream time base encountered: {}/{}",
                time_base.num, time_base.den
            )));
        }

        let origin = if start_time == sys::AV_NOPTS_VALUE {
            0
        } else {
            start_time.max(0)
        };

        Ok(Self {
            tb_num: i128::from(time_base.num),
            tb_den: i128::from(time_base.den),
            origin,
        })
    }

    /// Returns the raw timestamp to request from the demuxer so that decoding starts at or
    /// before `target`.
    pub fn seek_pts(&self, target: Duration) -> i64 {
        let ticks = (nanos(target) * self.tb_den).div_euclid(NANOS_PER_SEC * self.tb_num);
        saturate_i64(i128::from(self.origin) + ticks)
    }

    /// Places a decoded frame on the public timeline, trimming the samples that lie before
    /// `not_before`.
    ///
    /// Returns `None` when no sample of the frame lies at or after `not_before`. Frames without a
    /// raw timestamp cannot be located, so they are kept whole.
    pub fn place(&self, frame: FrameTiming, not_before: Duration) -> Option<FramePlacement> {
        if frame.pts == sys::AV_NOPTS_VALUE {
            return Some(FramePlacement {
                raw_pts: None,
                pts: None,
                end: None,
                duration: samples_to_duration(frame.samples, frame.sample_rate),
                offset: 0,
                samples: frame.samples,
            });
        }

        let start = self.relative_ticks(frame.pts);
        let first = self.first_sample_at_or_after(start, frame.sample_rate, nanos(not_before));
        let offset = usize::try_from(first)
            .ok()
            .filter(|&offset| offset < frame.samples)?;
        let samples = frame.samples - offset;

        Some(FramePlacement {
            raw_pts: Some(frame.pts),
            pts: Some(duration_from_nanos(self.floor_nanos(
                start,
                offset,
                frame.sample_rate,
            ))),
            end: Some(duration_from_nanos(self.floor_nanos(
                start,
                frame.samples,
                frame.sample_rate,
            ))),
            duration: samples_to_duration(samples, frame.sample_rate),
            offset,
            samples,
        })
    }

    /// Returns a packet's public timestamp, excluding preroll and missing timestamps.
    pub(crate) fn packet_pts(&self, pts: i64) -> Option<Duration> {
        if pts == sys::AV_NOPTS_VALUE {
            return None;
        }
        let ticks = self.relative_ticks(pts);
        (ticks >= 0).then(|| duration_from_nanos(self.floor_nanos(ticks, 0, 0)))
    }

    /// Returns the public end time of a demuxed packet, or `None` when the packet carries no
    /// timestamp or ends at or before zero.
    pub fn packet_end(&self, pts: i64, duration: i64) -> Option<Duration> {
        if pts == sys::AV_NOPTS_VALUE {
            return None;
        }

        let end = self.relative_ticks(pts) + i128::from(duration.max(0));
        let end_ns = self.floor_nanos(end, 0, 0);
        (end_ns > 0).then(|| duration_from_nanos(end_ns))
    }

    /// Returns the declared duration: the stream's own duration when known, otherwise the
    /// container's (given in microseconds).
    ///
    /// The declared duration is only an estimate of the exact duration; it is converted as is,
    /// without any adjustment for the origin.
    pub fn declared_duration(
        &self,
        stream_duration: i64,
        container_duration_us: i64,
    ) -> Option<Duration> {
        // `AV_NOPTS_VALUE` is negative, so the sign checks also reject missing durations.
        if stream_duration >= 0 {
            let duration_ns = self.floor_nanos(i128::from(stream_duration), 0, 0);
            return Some(duration_from_nanos(duration_ns));
        }

        (container_duration_us >= 0)
            .then(|| Duration::from_micros(container_duration_us.cast_unsigned()))
    }

    /// Converts a raw timestamp into raw ticks after the origin.
    fn relative_ticks(&self, pts: i64) -> i128 {
        i128::from(pts) - i128::from(self.origin)
    }

    /// Returns the index of the first sample at or after `not_before_ns`, counted from a frame
    /// that starts `start` raw ticks after the origin. Returns `i128::MAX` when no sample
    /// qualifies because the frame's samples cannot be located.
    fn first_sample_at_or_after(&self, start: i128, sample_rate: i32, not_before_ns: i128) -> i128 {
        // Sample `i` lies at `start * num / den + i / rate` seconds. Solving for the smallest `i`
        // at or after `not_before` gives `i >= rate * lead / (den * 1e9)`, where `lead` below is
        // the gap between the frame start and `not_before`, scaled by `den * 1e9`.
        let lead = not_before_ns * self.tb_den - start * self.tb_num * NANOS_PER_SEC;
        if lead <= 0 {
            return 0;
        }
        if sample_rate <= 0 {
            return i128::MAX;
        }

        let unit = self.tb_den * NANOS_PER_SEC;
        let rate = i128::from(sample_rate);
        let whole = lead.div_euclid(unit).saturating_mul(rate);
        let part = ceil_div(lead.rem_euclid(unit) * rate, unit);
        whole.saturating_add(part)
    }

    /// Returns the public time, in whole nanoseconds rounded down, of the point `samples` samples
    /// after a frame start lying `ticks` raw ticks after the origin.
    ///
    /// The samples are ignored when the sample rate is unknown.
    fn floor_nanos(&self, ticks: i128, samples: usize, sample_rate: i32) -> i128 {
        let scaled_ticks = ticks * self.tb_num * NANOS_PER_SEC;
        let whole = scaled_ticks.div_euclid(self.tb_den);
        if sample_rate <= 0 {
            return whole;
        }

        let rate = i128::from(sample_rate);
        let scaled_samples = samples as i128 * NANOS_PER_SEC;

        // Both remainders are below one nanosecond, so together they carry at most one more.
        let carry = scaled_ticks.rem_euclid(self.tb_den) * rate
            + scaled_samples.rem_euclid(rate) * self.tb_den
            >= self.tb_den * rate;

        whole + scaled_samples.div_euclid(rate) + i128::from(carry)
    }
}

/// Returns the playback duration of `samples` samples, rounded down to whole nanoseconds.
fn samples_to_duration(samples: usize, sample_rate: i32) -> Duration {
    if sample_rate <= 0 {
        return Duration::ZERO;
    }

    duration_from_nanos(samples as i128 * NANOS_PER_SEC / i128::from(sample_rate))
}

const fn nanos(duration: Duration) -> i128 {
    // A `Duration` holds fewer than 2^95 nanoseconds, which always fits.
    duration.as_nanos().cast_signed()
}

fn duration_from_nanos(nanos: i128) -> Duration {
    u64::try_from(nanos.max(0)).map_or(Duration::from_nanos(u64::MAX), Duration::from_nanos)
}

fn saturate_i64(value: i128) -> i64 {
    i64::try_from(value).unwrap_or(if value < 0 { i64::MIN } else { i64::MAX })
}

fn ceil_div(numerator: i128, denominator: i128) -> i128 {
    numerator.div_euclid(denominator) + i128::from(numerator.rem_euclid(denominator) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: sys::AVRational = sys::AVRational { num: 1, den: 1_000 };

    const fn rational(num: i32, den: i32) -> sys::AVRational {
        sys::AVRational { num, den }
    }

    const fn frame(pts: i64, samples: usize, sample_rate: i32) -> FrameTiming {
        FrameTiming {
            pts,
            samples,
            sample_rate,
        }
    }

    const fn ms(millis: u64) -> Duration {
        Duration::from_millis(millis)
    }

    fn timeline(time_base: sys::AVRational, start_time: i64) -> Timeline {
        Timeline::new(time_base, start_time).unwrap()
    }

    #[test]
    fn rejects_invalid_time_bases() {
        for (num, den) in [(0, 1_000), (-1, 1_000), (1, 0), (1, -1_000)] {
            assert!(
                Timeline::new(rational(num, den), 0).is_err(),
                "time base {num}/{den} must be rejected"
            );
        }
    }

    #[test]
    fn origin_is_the_declared_start_unless_negative_or_missing() {
        // (declared start time, raw timestamp that maps to public zero)
        let cases = [(1_400, 1_400), (0, 0), (-100, 0), (sys::AV_NOPTS_VALUE, 0)];

        for (start_time, origin) in cases {
            let placement = timeline(MS, start_time)
                .place(frame(origin, 48, 48_000), Duration::ZERO)
                .unwrap();
            assert_eq!(
                placement.pts(),
                Some(Duration::ZERO),
                "start time {start_time}"
            );
        }
    }

    #[test]
    fn trims_preroll_and_seek_targets_from_the_raw_frame() {
        // A 1024-sample frame at 48 kHz whose raw timestamp lies 15 ms before zero.
        let straddling = frame(-15, 1_024, 48_000);
        let timeline = timeline(MS, -100);

        // (not before, offset, delivered samples, pts)
        let cases = [
            (Duration::ZERO, 720, 304, Duration::ZERO),
            // Trimming for a seek target composes with the preroll trim instead of replacing it.
            (ms(3), 864, 160, ms(3)),
        ];

        for (not_before, offset, samples, pts) in cases {
            let placement = timeline.place(straddling, not_before).unwrap();
            assert_eq!(
                (placement.offset(), placement.samples(), placement.pts()),
                (offset, samples, Some(pts)),
                "not before {not_before:?}"
            );
        }
    }

    #[test]
    fn drops_frames_entirely_before_the_requested_time() {
        let timeline = timeline(MS, -100);

        // (frame, not before)
        let cases = [
            // Ends 79 ms before zero.
            (frame(-100, 1_024, 48_000), Duration::ZERO),
            // Ends at 6.33 ms, before the target.
            (frame(-15, 1_024, 48_000), ms(10)),
            // Ends exactly at the target, so its last sample lies before it.
            (frame(0, 480, 48_000), ms(10)),
            // Holds no samples at all.
            (frame(0, 0, 48_000), Duration::ZERO),
        ];

        for (decoded, not_before) in cases {
            assert_eq!(
                timeline.place(decoded, not_before),
                None,
                "{decoded:?} not before {not_before:?}"
            );
        }
    }

    #[test]
    fn keeps_frames_starting_after_the_requested_time_whole() {
        let placement = timeline(MS, 0)
            .place(frame(7, 1_024, 48_000), ms(3))
            .unwrap();

        assert_eq!(
            (placement.offset(), placement.samples(), placement.pts()),
            (0, 1_024, Some(ms(7)))
        );
    }

    #[test]
    fn rounds_sample_positions_up_and_reported_times_down() {
        // (time base, frame, not before, offset, pts)
        let cases = [
            // 1 ms at 44.1 kHz falls between samples 44 and 45; sample 45 lies at 1020408.16 ns.
            (
                rational(1, 44_100),
                frame(0, 4_096, 44_100),
                ms(1),
                45,
                Duration::from_nanos(1_020_408),
            ),
            // 100 ms lies exactly on sample 4800, even though the frame starts at 85333.33 us.
            (
                rational(1, 28_224_000),
                frame(2_408_448, 1_024, 48_000),
                ms(100),
                704,
                ms(100),
            ),
        ];

        for (time_base, decoded, not_before, offset, pts) in cases {
            let placement = timeline(time_base, 0).place(decoded, not_before).unwrap();
            assert_eq!(
                (placement.offset(), placement.pts()),
                (offset, Some(pts)),
                "{decoded:?} not before {not_before:?}"
            );
        }
    }

    #[test]
    fn seeking_to_a_reported_time_lands_on_the_same_sample() {
        let timeline = timeline(rational(1, 44_100), 0);
        let decoded = frame(0, 4_096, 44_100);

        for target in [1, 3, 7, 50, 92] {
            let placement = timeline.place(decoded, ms(target)).unwrap();
            let again = timeline.place(decoded, placement.pts().unwrap()).unwrap();
            assert_eq!(again, placement, "target {target} ms");
        }
    }

    #[test]
    fn end_is_the_time_right_after_the_last_sample() {
        let placement = timeline(MS, 0)
            .place(frame(881, 896, 48_000), Duration::ZERO)
            .unwrap();

        assert_eq!(placement.end(), Some(Duration::from_nanos(899_666_666)));
        assert_eq!(placement.duration(), Duration::from_nanos(18_666_666));
    }

    #[test]
    fn keeps_frames_without_timestamps_untrimmed() {
        let placement = timeline(MS, 0)
            .place(frame(sys::AV_NOPTS_VALUE, 1_024, 48_000), ms(5))
            .unwrap();

        assert_eq!(
            (
                placement.offset(),
                placement.samples(),
                placement.pts(),
                placement.end()
            ),
            (0, 1_024, None, None)
        );
        assert_eq!(placement.duration(), Duration::from_nanos(21_333_333));
    }

    #[test]
    fn frames_without_a_sample_rate_are_kept_or_dropped_whole() {
        let timeline = timeline(MS, 0);
        let decoded = frame(10, 1_024, 0);

        let placement = timeline.place(decoded, ms(5)).unwrap();
        assert_eq!(
            (
                placement.offset(),
                placement.samples(),
                placement.duration(),
                placement.pts(),
                placement.end()
            ),
            (0, 1_024, Duration::ZERO, Some(ms(10)), Some(ms(10)))
        );

        assert_eq!(timeline.place(decoded, ms(20)), None);
    }

    #[test]
    fn seek_timestamps_round_down_and_include_the_origin() {
        // (time base, declared start time, target, raw timestamp)
        let cases = [
            (MS, 0, ms(3), 3),
            (MS, 1_400, ms(3), 1_403),
            (MS, -100, Duration::ZERO, 0),
            (rational(1, 44_100), 0, ms(1), 44),
            (rational(1, 48_000), 0, ms(100), 4_800),
        ];

        for (time_base, start_time, target, pts) in cases {
            assert_eq!(
                timeline(time_base, start_time).seek_pts(target),
                pts,
                "target {target:?} with start time {start_time}"
            );
        }
    }

    #[test]
    fn packet_end_ignores_packets_without_public_samples() {
        let timeline = timeline(MS, -100);

        // (raw timestamp, raw duration, public end)
        let cases = [
            (-100, 21, None),
            (-15, 21, Some(ms(6))),
            (881, 18, Some(ms(899))),
            (50, 0, Some(ms(50))),
            (sys::AV_NOPTS_VALUE, 21, None),
        ];

        for (pts, duration, end) in cases {
            assert_eq!(
                timeline.packet_end(pts, duration),
                end,
                "packet at {pts} lasting {duration}"
            );
        }
    }

    #[test]
    fn declared_duration_prefers_the_stream_over_the_container() {
        let timeline = timeline(rational(1, 44_100), 0);

        // (stream duration, container duration in microseconds, declared duration)
        let cases = [
            (88_200, 5_000_000, Some(Duration::from_secs(2))),
            (sys::AV_NOPTS_VALUE, 900_000, Some(ms(900))),
            (sys::AV_NOPTS_VALUE, sys::AV_NOPTS_VALUE, None),
        ];

        for (stream_duration, container_duration, declared) in cases {
            assert_eq!(
                timeline.declared_duration(stream_duration, container_duration),
                declared,
                "stream {stream_duration}, container {container_duration}"
            );
        }
    }

    #[test]
    fn extreme_timestamps_saturate_instead_of_overflowing() {
        let coarse = timeline(rational(i32::MAX, 1), 0);
        let placement = coarse
            .place(frame(i64::MAX, 1_024, i32::MAX), Duration::ZERO)
            .unwrap();
        assert_eq!(placement.pts(), Some(Duration::from_nanos(u64::MAX)));
        assert_eq!(
            coarse.place(frame(i64::MIN + 1, 1_024, 48_000), Duration::MAX),
            None
        );

        let fine = timeline(rational(1, i32::MAX), i64::MAX);
        assert_eq!(fine.seek_pts(Duration::MAX), i64::MAX);
        assert_eq!(fine.packet_end(i64::MIN + 1, i64::MAX), None);
    }
}
