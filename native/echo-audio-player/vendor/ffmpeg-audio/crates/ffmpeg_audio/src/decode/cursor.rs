use std::time::Duration;

use crate::{core::timeline::FramePlacement, decode::SeekMode};

/// How reading resumes after the stream was scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resume {
    /// Repeat this seek.
    Seek { target: Duration, mode: SeekMode },

    /// Continue with the frame that follows the one whose raw timestamp is `raw_pts`; that frame
    /// is expected to start around `next`.
    After { raw_pts: i64, next: Duration },

    /// Nothing is left to read.
    Exhausted,
}

/// Where reading stands, as far as callers can observe it.
///
/// The cursor records what happened to the stream (seeks, delivered frames, exhaustion) and
/// answers two questions: which stream position to report, and how to put reading back where it
/// was after the stream has been scanned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReadCursor {
    state: State,
}

/// In every state but `Start`, `position` is the stream position reported until the next frame
/// is delivered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum State {
    /// Nothing has been delivered since the stream was opened.
    #[default]
    Start,

    /// A coarse seek to `target` completed, and no frame with a timestamp has been delivered
    /// since.
    Coarse {
        target: Duration,
        position: Option<Duration>,
    },

    /// A seek decoded `frame`, which waits to be delivered; `resume` repeats that seek.
    ///
    /// The frame's samples stay in the decoder, which must not decode anything else until the
    /// frame has been delivered.
    Pending {
        resume: Resume,
        frame: FramePlacement,
        position: Option<Duration>,
    },

    /// Frames have been delivered. The last one has the raw timestamp `last_raw_pts`, and the
    /// next one starts at `next`.
    Reading {
        position: Option<Duration>,
        next: Duration,
        last_raw_pts: Option<i64>,
    },

    /// The stream is exhausted.
    Exhausted { position: Option<Duration> },
}

impl ReadCursor {
    /// Records a completed coarse seek to `target`.
    pub const fn record_coarse_seek(&mut self, target: Duration) {
        self.state = State::Coarse {
            target,
            position: None,
        };
    }

    /// Records a seek that decoded `frame`, which the decoder now holds; `resume` repeats the
    /// seek.
    pub const fn record_pending(&mut self, resume: Resume, frame: FramePlacement) {
        self.state = State::Pending {
            resume,
            frame,
            position: None,
        };
    }

    /// Records that `frame` has been delivered.
    pub const fn record_delivery(&mut self, frame: FramePlacement) {
        self.state = match (frame.pts(), frame.end()) {
            (Some(pts), Some(end)) => State::Reading {
                position: Some(pts),
                next: end,
                last_raw_pts: frame.raw_pts(),
            },
            // Frames without a timestamp advance a known position by their duration: the end of
            // the previous frame, or the position a pending frame's seek was headed for.
            _ => match self.state {
                State::Start => State::Reading {
                    position: None,
                    next: frame.duration(),
                    last_raw_pts: None,
                },
                State::Reading { next, .. }
                | State::Pending {
                    resume: Resume::Seek { target: next, .. } | Resume::After { next, .. },
                    ..
                } => State::Reading {
                    position: None,
                    next: next.saturating_add(frame.duration()),
                    last_raw_pts: None,
                },
                // Where the coarse seek landed is unknown, so there is no position to advance.
                // Resuming replays that seek, which delivers these frames once more.
                State::Coarse { target, .. } => State::Coarse {
                    target,
                    position: None,
                },
                // Nothing is delivered once the stream is exhausted, and no seek leaves a frame
                // pending without a way to repeat it.
                state @ (State::Pending {
                    resume: Resume::Exhausted,
                    ..
                }
                | State::Exhausted { .. }) => state,
            },
        };
    }

    /// Records that the stream is exhausted.
    pub const fn record_exhaustion(&mut self) {
        self.state = State::Exhausted {
            position: self.stream_position(),
        };
    }

    /// Keeps reporting `position` as the stream position until the next frame is delivered.
    ///
    /// A scan calls this after resuming as told by [`resume`](Self::resume), so that the scan
    /// stays invisible to the caller.
    pub const fn restore_position(&mut self, position: Option<Duration>) {
        match &mut self.state {
            State::Start => {}
            State::Coarse {
                position: current, ..
            }
            | State::Pending {
                position: current, ..
            }
            | State::Reading {
                position: current, ..
            }
            | State::Exhausted { position: current } => *current = position,
        }
    }

    /// Returns the frame a seek left waiting to be delivered, if any.
    pub const fn pending(&self) -> Option<FramePlacement> {
        match self.state {
            State::Pending { frame, .. } => Some(frame),
            _ => None,
        }
    }

    pub const fn is_exhausted(&self) -> bool {
        matches!(self.state, State::Exhausted { .. })
    }

    /// Returns the timestamp of the most recently delivered frame; `None` before the first frame,
    /// after a seek, or when that frame has no timestamp.
    pub const fn stream_position(&self) -> Option<Duration> {
        match self.state {
            State::Start => None,
            State::Coarse { position, .. }
            | State::Pending { position, .. }
            | State::Reading { position, .. }
            | State::Exhausted { position } => position,
        }
    }

    /// Returns how to put reading back where it stands now, once the stream has been scanned.
    pub const fn resume(&self) -> Resume {
        match self.state {
            State::Start => Resume::Seek {
                target: Duration::ZERO,
                mode: SeekMode::Coarse,
            },
            State::Coarse { target, .. } => Resume::Seek {
                target,
                mode: SeekMode::Coarse,
            },
            State::Pending { resume, .. } => resume,
            // Continuing after the last frame reproduces the frames exactly, even where the
            // container's timestamps disagree with the sample counts.
            State::Reading {
                next,
                last_raw_pts: Some(raw_pts),
                ..
            } => Resume::After { raw_pts, next },
            // Without a raw timestamp to find the last frame again, seek to where the next one
            // should start.
            State::Reading {
                next,
                last_raw_pts: None,
                ..
            } => Resume::Seek {
                target: next,
                mode: SeekMode::Accurate,
            },
            State::Exhausted { .. } => Resume::Exhausted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        core::timeline::{FrameTiming, Timeline},
        sys,
    };

    const RATE: i32 = 48_000;

    /// Duration of the 1024-sample frames built by [`frame`].
    const FRAME: Duration = Duration::from_nanos(21_333_333);

    const COARSE_500: Resume = Resume::Seek {
        target: Duration::from_millis(500),
        mode: SeekMode::Coarse,
    };

    const ACCURATE_500: Resume = Resume::Seek {
        target: Duration::from_millis(500),
        mode: SeekMode::Accurate,
    };

    /// A 1024-sample frame at 48 kHz whose raw timestamp counts samples, or has no timestamp.
    fn frame(raw_pts: Option<i64>) -> FramePlacement {
        let timeline = Timeline::new(sys::AVRational { num: 1, den: RATE }, 0).unwrap();
        let timing = FrameTiming {
            pts: raw_pts.unwrap_or(sys::AV_NOPTS_VALUE),
            samples: 1_024,
            sample_rate: RATE,
        };
        timeline.place(timing, Duration::ZERO).unwrap()
    }

    #[derive(Debug, Clone, Copy)]
    enum Event {
        CoarseSeek(Duration),
        Pending(Resume, FramePlacement),
        Deliver(FramePlacement),
        Exhaust,
        RestorePosition(Option<Duration>),
    }

    fn cursor_after(events: &[Event]) -> ReadCursor {
        let mut cursor = ReadCursor::default();
        for &event in events {
            match event {
                Event::CoarseSeek(target) => cursor.record_coarse_seek(target),
                Event::Pending(resume, frame) => cursor.record_pending(resume, frame),
                Event::Deliver(frame) => cursor.record_delivery(frame),
                Event::Exhaust => cursor.record_exhaustion(),
                Event::RestorePosition(position) => cursor.restore_position(position),
            }
        }
        cursor
    }

    #[test]
    fn reports_the_stream_position_and_how_to_resume() {
        use Event::*;

        let first = frame(Some(0));
        let second = frame(Some(1_024));
        let after_second = Resume::After {
            raw_pts: 1_024,
            next: second.end().unwrap(),
        };

        // (situation, events, stream position, resume)
        let cases = [
            (
                "start",
                vec![],
                None,
                Resume::Seek {
                    target: Duration::ZERO,
                    mode: SeekMode::Coarse,
                },
            ),
            (
                "coarse seek",
                vec![CoarseSeek(Duration::from_millis(500))],
                None,
                COARSE_500,
            ),
            (
                "accurate seek",
                vec![Pending(ACCURATE_500, second)],
                None,
                ACCURATE_500,
            ),
            (
                "reading",
                vec![Deliver(first), Deliver(second)],
                second.pts(),
                after_second,
            ),
            (
                "reading after an accurate seek",
                vec![Pending(ACCURATE_500, second), Deliver(second)],
                second.pts(),
                after_second,
            ),
            (
                "exhausted while reading",
                vec![Deliver(first), Exhaust],
                first.pts(),
                Resume::Exhausted,
            ),
            (
                "exhausted right after a seek",
                vec![CoarseSeek(Duration::from_millis(500)), Exhaust],
                None,
                Resume::Exhausted,
            ),
            (
                "restored after a scan",
                vec![
                    Deliver(first),
                    CoarseSeek(Duration::from_millis(500)),
                    RestorePosition(first.pts()),
                ],
                first.pts(),
                COARSE_500,
            ),
            (
                "delivery after a restored position",
                vec![
                    CoarseSeek(Duration::from_millis(500)),
                    RestorePosition(first.pts()),
                    Deliver(second),
                ],
                second.pts(),
                after_second,
            ),
        ];

        for (situation, events, position, resume) in cases {
            let cursor = cursor_after(&events);
            assert_eq!(cursor.stream_position(), position, "{situation}");
            assert_eq!(cursor.resume(), resume, "{situation}");
            assert_eq!(
                cursor.is_exhausted(),
                resume == Resume::Exhausted,
                "{situation}"
            );
        }
    }

    #[test]
    fn frames_without_timestamps_advance_the_last_known_position() {
        use Event::*;

        let untimed = frame(None);
        let timed = frame(Some(0));

        // (situation, events, resume)
        let cases = [
            (
                "from the start",
                vec![Deliver(untimed), Deliver(untimed)],
                Resume::Seek {
                    target: FRAME * 2,
                    mode: SeekMode::Accurate,
                },
            ),
            (
                "after a frame with a timestamp",
                vec![Deliver(timed), Deliver(untimed)],
                Resume::Seek {
                    target: timed.end().unwrap() + FRAME,
                    mode: SeekMode::Accurate,
                },
            ),
            (
                "as the pending frame",
                vec![
                    Pending(
                        Resume::After {
                            raw_pts: 0,
                            next: FRAME,
                        },
                        untimed,
                    ),
                    Deliver(untimed),
                ],
                Resume::Seek {
                    target: FRAME * 2,
                    mode: SeekMode::Accurate,
                },
            ),
            // Where a coarse seek landed is unknown, so resuming repeats the seek.
            (
                "after a coarse seek",
                vec![CoarseSeek(Duration::from_millis(500)), Deliver(untimed)],
                COARSE_500,
            ),
        ];

        for (situation, events, resume) in cases {
            let cursor = cursor_after(&events);
            assert_eq!(cursor.stream_position(), None, "{situation}");
            assert_eq!(cursor.resume(), resume, "{situation}");
        }
    }

    #[test]
    fn delivering_the_pending_frame_clears_it() {
        for pending in [frame(Some(1_024)), frame(None)] {
            let resume = Resume::After {
                raw_pts: 0,
                next: FRAME,
            };
            let mut cursor = cursor_after(&[Event::Pending(resume, pending)]);
            assert_eq!(cursor.pending(), Some(pending));

            cursor.record_delivery(pending);
            assert_eq!(cursor.pending(), None, "{pending:?}");
        }
    }
}
