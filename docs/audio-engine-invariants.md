# Audio Engine Invariants

Design decisions in `native/echo-ffmpeg-player` that are not obvious from the code, together with
the reasoning behind them. Each entry states the rule, why the alternative was rejected, and how to
tell if a future change has broken it.

Read this before changing thread boundaries, the output callback, or the vendored
`ffmpeg-audio` crate. Several rules exist because the naive version was tried and produced a
specific user-visible failure.

```text
decode thread -> decoded_queue -> filter thread -> RealtimeAudioRing -> output callback
                                       |                                     |
                                  DSP / tempo                        pending fields
                                                                             |
                                                                     signal thread -> JS events
```

## Realtime Callback

### The callback never blocks, allocates, or sends on an unbounded channel

This is the single most important rule in the module. The output callback runs on a deadline
owned by the audio device; missing it produces an audible dropout.

Concretely, inside `pop_chunk_into` / `pop_into` and everything they reach:

- Locks are `try_lock` only. `gapless_boundary`, `pending_track_switch`, `spectrum_ring` and
  `output_stats` all follow this. A blocking `lock()` here contends with the filter thread and
  produces clicks at track boundaries.
- Scratch buffers are pre-reserved at stream startup. Callback-side `resize` is allowed only
  because capacity is guaranteed; if a request exceeds the reservation the callback outputs
  silence rather than reallocating.
- Semantic state travels through pending fields, not through channel payloads. See below.

When adding anything to this path, assume a `Vec` growth or a contended mutex is a bug even if it
"usually" works — the failure mode is intermittent and hard to attribute.

### Control signals live in pending fields; the channel is only a wake token

`wake_control_signal` sends `()` on a capacity-1 `SyncSender` and ignores send failure. All actual
state lives in `pending_track_switch`, `pending_playback_end`, `pending_playback_restart_bits` and
the ao-state fields, which the signal thread drains in `take_pending_control_signal`.

Dropping a wake token is therefore harmless: a full channel means the consumer is already
scheduled, and it will re-scan the pending fields when it runs. The earlier design sent
`PlaybackSignal` values on an unbounded `Sender`, which allocated a queue node inside the callback
and — once bounded — could silently lose a `TrackSwitch` or `PlaybackEnd`, leaving the UI stuck.

If you add a new control signal, add a pending field for it. Do not widen the wake channel.

### `RealtimeAudioRing::clear()` does not write the consumer index

The ring is SPSC: only the output callback writes `read`. `clear()` runs on a control thread, so it
publishes a `clear_before` watermark instead. Producers treat it as reclaimed capacity immediately
via `effective_read`; the consumer advances `read` past it at the start of its next `pop_into`.

Writing `read` directly from the control thread — the obvious implementation — lets a concurrent
callback store a stale `read + take`, which either resurrects discarded audio after a seek or
underflows `write - read` into apparent silence.

### Output scratch has a floor, and over-budget means silence, not growth

Both the CoreAudio and cpal paths clamp their reservation to a floor of 32768 frames. Hosts do not
always honour the buffer size they advertise, and a reservation derived only from the advertised
size can be exceeded. cpal uses `FALLBACK_REALTIME_BUFFER_FRAMES`; CoreAudio currently repeats the
literal, which is worth extracting into a shared constant.

The over-budget branch is stateless per callback: it fills silence and returns, so the next
callback recovers if the size drops back. Do not add a sticky "degraded" flag here — that turns a
one-callback glitch into permanent silence.

## DSP

### Sample sanitisation happens once, at the graph boundary

`DspChain::process_interleaved` calls `sanitize_samples` on entry, before any stateful stage. A
single non-finite sample that reaches the convolver's `input_spectra` or the tempo engine's WSOLA
overlap buffer poisons that state permanently — output stays NaN until a full `drain()`.

Per-stage guards were tried and are insufficient: the EQ returns early when all gains are zero, and
the direct-copy path in `convert_with_swr` bypasses conversion entirely, so both skip any check
placed downstream. Keep the check at the entry point rather than distributing it.

### EQ headroom is measured on a logarithmic grid

`eq_headroom_gain` samples the cascade response at `EQ_RESPONSE_LOG_POINTS` (512) points spaced
logarithmically from `EQ_RESPONSE_MIN_FREQUENCY` (10 Hz) to Nyquist, plus DC, Nyquist, and each
band centre frequency explicitly.

A linear grid is the trap here. The lowest band sits at 31 Hz with Q = 1.414; on a 2048-point
linear grid at 48 kHz that peak lands near bin 2.6 and falls between samples, so headroom is
under-estimated by roughly 1.6 dB — about 7 dB at 192 kHz — which clips exactly where it is most
audible. The band centres are included explicitly so the estimate does not depend on how the grid
happens to align at a given sample rate.

Verification: compare against a high-resolution reference across sample rates for single-band and
multi-band gains. The log grid stays within 0.01 dB. The in-tree test
(`equalizer_headroom_does_not_miss_narrow_low_frequency_peak`) uses a 32768-point reference and
covers a single-band boost; multi-band combinations are not yet covered.

### The limiter ramps attenuation across the lookahead window

`attack_coefficient = 1 - 1e-6^(1/LOOKAHEAD)` spreads the gain reduction over the full 256-frame
lookahead. The peak tree reports a peak `LOOKAHEAD` frames before the corresponding sample leaves
the delay line, and the ramp is sized to consume exactly that window.

Applying the target gain in one step — which the lookahead makes tempting, since the reduction is
never late — puts a discontinuity on a non-zero sample and produces a click on every transient.

### Seek reuses DSP state instead of rebuilding it

`AudioGraph::reset` takes a fast path when `can_reset_state` holds: formats match and the spatial
resource identity is unchanged. It then calls `reset_state`, which clears filter memory in place
and keeps the `FftPlanner` and the `Arc<PreparedImpulseSegment>`.

Full reconstruction allocates tens of megabytes for a long impulse response (roughly 6 MB per
channel per segment for an 8 s IR) and re-plans the FFT, synchronously on the filter thread. The
audible result is a gap when seeking with a long reverb loaded.

Providers deliberately fail `can_reset_state`. A provider reset can fail after it has already
mutated opaque external state, so seek rebuilds that graph transactionally rather than risking a
half-reset. The `debug_assert!(self.provider.is_none())` in `reset_state` documents this.

The commit order in the fast path matters: construct the fallible `TempoProcessor` and run
`reset_state` first, publish converter/tempo/nodes last. Reversing it leaves a half-reset graph
when a later step fails.

## Event Delivery

### Telemetry is droppable; state is not

`is_droppable_when_event_queue_is_full` whitelists `time-update`, `log`, `ao-state-change` and the
stats events. Everything else — `state-change`, `playback-end`, `error`, `seek`, `file-loaded`,
`audio-graph-change` — is retained and retried.

Retry budgets are two-level and deliberately asymmetric: `CRITICAL_DISPATCH_QUEUE_RETRY_BUDGET`
(1 s) for the producer-side enqueue and `CRITICAL_CALLBACK_QUEUE_RETRY_BUDGET` (2 s) for TSFN
delivery. The outer budget is smaller so the two cannot stack.

Both loops also exit on `EVENT_DISPATCHER_STOPPING`. That flag is set *before* the shutdown message
and the join, which is what keeps `initialize()` from deadlocking: it calls
`shutdown_runtime(false)`, which does not clear the callback, so a queue-full retry with no
independent escape would spin against a JS thread that is itself blocked in the join.

### Drops are counted, not inferred from ID gaps

`DROPPED_EVENT_COUNT` and `DROPPED_CRITICAL_EVENT_COUNT` ride along on the next successfully
delivered event. The JS side reads those counters and distinguishes lost telemetry from a possible
state-machine divergence.

Gap detection on `eventId` was removed. IDs are assigned on the producer side, so several threads
allocate concurrently and deliver independently — delivery order does not match ID order and the
gap check produced false positives. Do not reintroduce it without moving ID assignment back onto
the dispatcher thread.

## Platform Output

### A CoreAudio IOProc context is leaked rather than freed on an uncertain teardown

`CoreAudioExclusiveOutput::drop` frees the boxed context only when
`AudioDeviceDestroyIOProcID` returns 0. CoreAudio does not guarantee that a callback has finished
when the status is non-zero, and the render callback dereferences that pointer.

A leaked context is bounded and harmless; a use-after-free in the audio render thread crashes the
whole Electron process. When in doubt, leak.

### Every `extern "C"` callback is wrapped in `catch_unwind`

Panicking across an `extern "C"` boundary aborts the process (Rust 1.81 and later, independent of
edition). `run_coreaudio_callback` in `device/platform_macos.rs` contains the unwind;
`render_callback` and both property listeners go through it.

The render path additionally fills silence when the wrapped call reports a panic. Returning early
instead would leave a half-filled buffer, and CoreAudio would play whatever was already in it.
Apply the same shape to any new platform callback rather than relying on the body being
panic-free.

### The WASAPI exclusive period is whatever the driver reports

`wasapi_exclusive_buffer_duration` passes `GetDevicePeriod`'s `defaultPeriod` straight through,
falling back to `minimum_period` and then to `FALLBACK_EXCLUSIVE_BUFFER_100NS` only when the driver
reports nothing usable. It deliberately does not clamp the value upward.

Clamping to a "safe" minimum looks harmless and is not: exclusive-mode drivers frequently accept
only their advertised periods, so raising the request to a rounder number gets it rejected with
`AUDCLNT_E_INVALID_DEVICE_PERIOD`. This matches mpv's `fix_format`, which uses `defaultPeriod`
verbatim and applies `MPMAX(..., minPeriod)` only to a user-specified period.

The resulting device buffer is 3-10 ms. That is expected and does not shrink the software queue —
`register_output_device_buffer` only ever raises `output_buffer_target_samples`, which is sized
from `audio_buffer_secs` (200 ms by default, same as mpv).

### The buffer-alignment retry is the documented MSDN flow, not an API misuse

On `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`, `open_wasapi_output` calls `GetBufferSize` on the client
whose `Initialize` just failed, then loops to activate a fresh client and re-initialise with the
aligned frame count.

Calling `GetBufferSize` before a successful `Initialize` normally returns
`AUDCLNT_E_NOT_INITIALIZED`, so this reads like a bug on inspection. It is not — MSDN defines this
error as the exception, and the returned size is the required base for the retry. mpv does exactly
the same (`// According to MSDN, we must use this as base after the failure`), including releasing
the client before retrying and giving up if the second attempt still reports misalignment.

Retrying once is the intended behaviour. Falling back to `minimum_period` when `GetBufferSize`
fails would be extra defence for broken drivers, not a correction — do not add it under the belief
that the current flow is wrong.

The `catch_unwind` in `device/platform_linux.rs` is unrelated — it guards a normal Rust closure in
`with_pulse_audio_host`, not an FFI callback.

## Packet Cache (vendored)

These rules live in `vendor/ffmpeg-audio`. They are local modifications — re-apply them when
syncing the vendored crate upstream.

### Cached seek is limited to the current range

The background demuxer has one physical cursor, positioned at the prefetch tail of the current
range. Rewinding inside that range replays cached packets and the worker continues from the same
tail, which is safe. Jumping into a retained non-current range is not: its cached tail and the
cursor are unrelated, so when the cache runs out the worker appends packets from the old cursor and
creates a timestamp discontinuity.

`packet_cache_seek_offset` therefore returns `None` for cross-range hits, forcing a real demuxer
seek and an epoch bump.

`packet_cache_seekable_ranges` reports only the current range for the same reason. Retained ranges
still matter for the memory budget, but advertising them to the UI as instantly seekable means the
progress bar shows a buffered region that stalls when the user clicks it.

### `read_cancelled` and `read_failed` are different states

An intentional interrupt is not a failure. `seek()` raises the interrupt flag on every seek, so
`AVERROR_EXIT` arrives on the normal control path — treating it as an IO error poisons the cache,
makes `try_seek_cached` refuse every subsequent hit, and effectively disables cached seeking on
network streams.

`set_packet_cache_error` routes `AVERROR_EXIT` (via `is_interrupt_error`) to `read_cancelled`,
which parks the worker without recording an error. Recovery is either a real seek or
`PacketCacheAction::Resume`, both of which clear the flag and the interrupt. `read_failed` is for
genuine IO errors and is cleared only by a real seek; `abort_timed_out_packet_cache_seek` also
raises it (alongside `read_cancelled`) so a timed-out seek is forced down the real-seek path.

Note that `Ok(None)` from a read also checks the interrupt flag before recording EOF. Without that
check an interrupted read looks like end-of-stream and truncates playback silently.

### The worker parks on error instead of retrying

`packet_cache_worker_can_read` includes `!read_failed && !read_cancelled`. AVIO errors are sticky:
once set, FFmpeg stops calling `read_packet`, so retrying immediately becomes a busy loop that
saturates a core while the consumer waits for the forward buffer to drain.

### Teardown interrupts before joining

`PacketCache::drop` sets `stop` and raises the interrupt flag in the same critical section, then
notifies and joins the worker. The flag reaches `HttpAudioSource` through the same `Arc` that
`request_decode_interrupt` uses, so a blocked `av_read_frame` actually unblocks and the join is
bounded.

Without an `AVIOInterruptCB` there is no way to interrupt a blocked read, and a detached worker
holds its cached packets — up to 200 MB per abandoned track under the default budget — plus an open
socket, for as long as the HTTP retry schedule runs.

The cost is that teardown now runs on the caller's thread (roughly 250 ms worst case, dominated by
the cancel bridge poll and `RUNTIME_SHUTDOWN_TIMEOUT`). That is an accepted trade against leaking.

### The tokio runtime is shut down with a deadline

`HttpAudioSource` holds `Option<Runtime>` and calls `shutdown_timeout(RUNTIME_SHUTDOWN_TIMEOUT)` on
drop. Dropping a `Runtime` directly is equivalent to `shutdown_timeout(MAX)`, and blocking-pool
tasks cannot be cancelled — reqwest's default DNS resolution runs there and can hang for ~30 s,
which would block whichever thread happens to drop the source.

`body_reader` is cleared before shutdown so in-flight streaming connections close cleanly.

### `cancel()` on drop is gated by ownership

`owns_cancel_handle` distinguishes a handle created internally from one supplied by the caller.
Cancelling a caller-supplied handle on drop would poison it for whatever else shares it — a
subsequent source constructed with the same handle returns `Cancelled` immediately.

### Borrowed frame data is tied to `&self`

`AudioFrame::raw_data` returns `RawAudioData<'_, T>`, not `RawAudioData<'a, T>`. The struct
lifetime `'a` comes from the reader borrow, which outlives the frame; binding the returned slice to
it allows `drop(frame)` followed by `receive_frame()`, and the latter calls `av_frame_unref` and
frees the buffer the slice still points at.

### `Send` on FFmpeg wrappers is about exclusive ownership

`SwrContext` is not thread-safe. `unsafe impl Send` is nonetheless correct for `Resampler` because
the wrapper owns the context exclusively and never shares it. That reasoning does not extend to
`Sync` — concurrent `swr_convert` calls would corrupt internal state. Do not add it.

## Configuration

### Non-finite input is replaced with the default, not clamped

`f64::clamp` propagates NaN, and `Duration::from_secs_f64(NaN)` panics — on a libuv worker thread,
which aborts the process. `config.rs` routes every floating-point option through `finite_or` /
`finite_clamp` so `initialize({ networkTimeoutSecs: NaN })` cannot reach a `Duration`.

Some fields survived previously only because `f64::max` returns the other operand for NaN. That is
accidental, not a pattern to copy.

### Mutex poisoning must not be terminal

`runtime_guard()` recovers with `unwrap_or_else(|poisoned| poisoned.into_inner())`, and the core
dispatcher wraps command execution in `catch_unwind`.

A poisoned `RUNTIME` used to be unrecoverable: every `with_runtime` returned an error, including
the one inside `shutdown_runtime`, so `destroy()` and a fresh `initialize()` were both blocked. The
player was dead while the process kept running.
