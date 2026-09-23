# AirPlay 2 Audio Streaming Architecture & Timing Jitter Problem

## System Architecture

### Hardware
- **Sender:** Raspberry Pi Zero 2 W (4-core ARM Cortex-A53, 1GHz)
- **Network:** Broadcom BCM4329 WiFi (brcmfmac driver)
- **Receiver:** Apple HomePod
- **OS:** Raspberry Pi OS (Linux 6.12.47)

### Software Stack
- **Language:** Rust with Tokio async runtime (configured for 4 worker threads)
- **Protocol:** AirPlay 2 (RTSP control + RTP/UDP audio + NTP timing)
- **Audio Codec:** ALAC (Apple Lossless) - 44100Hz, 16-bit stereo, 352 samples per frame
- **Encryption:** ChaCha20-Poly1305 (AirPlay 2) or AES-CBC (AirPlay 1/RAOP)
- **Timing:** NTP-based synchronization

### Streaming Pipeline

```
AudioDecoder (MP3/FLAC/etc)
    ↓ (batch decode: 5 frames at a time)
AudioBuffer (ring buffer with fill percentage monitoring)
    ↓ (pop single frame)
ALAC Encoder (0.18ms per frame on Pi)
    ↓
ChaCha20-Poly1305 Encryption (0.15ms per frame)
    ↓
RTP Packet Formation + UDP Send
    ↓ (every 8ms = 352 samples ÷ 44100 Hz)
WiFi → HomePod
```

**Target Timing:** Exactly **8.00ms** per frame (125 frames/sec)

## The Problem: Audio Pops Due to Timing Jitter

### Symptom
Occasional audio "pops" or glitches during playback, despite audio data being valid and transmitted successfully.

### Root Cause Analysis

**1. HomePod Buffer Limitation**
- We request `latency_min: 22050` samples (~500ms buffer)
- **HomePod ignores this and only uses 70ms** (`arrivalToRenderLatencyMs: 70`)
- This 70ms buffer is extremely tight for non-real-time systems

**2. Linux Kernel Timer Granularity**
- Default `CONFIG_HZ=250` → 4ms timer tick
- `tokio::time::sleep()` has ±2ms variance around target
- Even with `SCHED_FIFO` RT priority (priority 50), sleep precision limited by kernel

**3. Measured Timing Jitter**
```
Expected: 8.000ms between packets
Observed: 6.4ms to 9.9ms (±1.5ms jitter)

Example packet intervals:
8.2ms, 8.9ms, 7.2ms, 8.5ms, 7.7ms, 8.3ms...
```

**4. Buffer Underrun**
- With 70ms buffer and ±1.5ms jitter, packets occasionally arrive late
- HomePod's playout buffer underruns → audible pop
- Retransmit mechanism exists but doesn't help with timing issues

### Performance Profile

**CPU Usage:** Only 5.5% per frame (encode + encrypt + send = 0.33ms out of 8ms budget)
- Encode: 0.18ms
- Send (encrypt + UDP): 0.15ms
- **Available time:** 7.67ms per frame

**The CPU is not the bottleneck** - we have 94.5% idle time. The issue is **sleep precision**.

## Optimizations Already Implemented

### Memory Optimizations
1. **Arc<Vec<i16>> for audio samples** - eliminated 175 KB/sec of clones
2. **RTP packet history** - move instead of clone (saved 29.5 KB/sec)
3. **Total savings:** ~204 KB/sec eliminated

### Timing Optimizations
1. **RT Priority:** `sched_setscheduler(SCHED_FIFO, 50)` - helps but limited by kernel timer
2. **Tokio 4-thread runtime** - full core utilization
3. **Absolute deadline scheduling** - accumulates target time to prevent drift
4. **Small decode batches** - 5 frames to minimize blocking
5. **Buffer threshold** - 60% to keep pipeline fed

### What Didn't Work
1. **`tokio::task::spawn_blocking` for encoding** - added 1-2ms overhead, made jitter worse
2. **spin_sleep / busy-wait** - consumed CPU without improving precision (async runtime interference)
3. **Increased latency requests** - HomePod ignores them
4. **Aggressive buffering** - doesn't help when timing is the issue

## System Constraints

### Hardware Limitations
- **No SO_TXTIME support:** `brcmfmac` WiFi driver doesn't support hardware TX timestamping
- **No sch_etf qdisc:** tc tool not installed, and WiFi drivers rarely support precise TX scheduling anyway
- **WiFi MAC layer:** 802.11 CSMA/CA adds variable latency (airtime contention, retries, etc.)

### Kernel Limitations
- **4ms timer granularity:** Even high-resolution timers limited by `CONFIG_HZ=250`
- **Non-deterministic scheduling:** Even with SCHED_FIFO, kernel can preempt for interrupts, etc.
- **Tokio async overhead:** Waking async tasks has inherent variance

### Protocol Limitations
- **HomePod controls buffer:** Ignores our latency_min/max requests, uses 70ms
- **No jitter buffer negotiation:** Can't request larger buffer
- **Retransmit won't help:** We're not losing packets, they're just mistimed

## Code Location

**Main streaming loop:** `crates/airplay-audio/src/streamer.rs`
- Function: `run_streamer()` (line ~294)
- Timing logic: Uses `Instant` and `tokio::time::sleep(next_deadline - now)`

**Key insight:** The loop holds a mutex lock during encode+send (~0.33ms), releases it during sleep (~7.67ms). Lock contention is not an issue - NTP/control tasks run in parallel without blocking.

## Potential Solutions to Investigate

### 1. Dedicated OS Thread with Kernel Bypass
Instead of Tokio async, use a real-time OS thread:
```rust
std::thread::Builder::new()
    .name("rt-sender".into())
    .spawn(move || {
        // Set SCHED_FIFO priority 50
        // Use spin_sleep::sleep() or timerfd for better precision
        // Send packets directly without async overhead
    })
```

### 2. User-Space High-Resolution Timers
- Use `timerfd_create()` with `TFD_TIMER_ABSTIME` for nanosecond precision
- Blocks on timer fd instead of sleep
- Might achieve <100μs jitter on Linux

### 3. Kernel Module / eBPF
- eBPF XDP program to schedule packet TX
- Bypass network stack for deterministic timing
- Complex but could achieve <10μs precision

### 4. Increase Frame Size
- Use 1024 samples/frame instead of 352 (if HomePod supports)
- Reduces packet rate from 125/sec to 43/sec
- 23ms intervals easier to hit than 8ms

### 5. Pre-compute & Queue Packets
- Encode multiple frames ahead of time
- Queue packets with target timestamps
- Separate thread just does precise timed sends

## Questions for Investigation

1. **Can we achieve <1ms sleep precision on Linux without kernel modifications?**
   - timerfd_create with CLOCK_MONOTONIC?
   - POSIX real-time timers (timer_create with SIGEV_THREAD)?
   - Busy-wait in dedicated OS thread?

2. **Can we negotiate a larger buffer with HomePod?**
   - Try different StreamType (Buffered instead of Realtime)?
   - Different timing protocols (PTP instead of NTP)?

3. **Could we use SO_TIMESTAMPING for feedback control?**
   - Measure actual TX times
   - Adjust sleep duration dynamically based on error

## Current Status

The audio works and plays through to completion. CPU usage is low (5.5% per frame). The issue is purely timing precision - we need to hit 8ms intervals with <1ms error to avoid underruns in the HomePod's 70ms buffer, but Linux kernel timer granularity gives us ±1.5ms jitter.

**Test command:** `sudo /home/raspberry/play_audio 192.168.0.103 7000 /home/raspberry/test_tone.mp3 --airplay2`

**Observed behavior:** Audio plays successfully with occasional pops/glitches caused by timing jitter exceeding the 70ms buffer tolerance.
