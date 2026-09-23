# AirPlay 2 Sender

An open-source Rust implementation of an AirPlay 2 audio transmitter (sender).

## Project Status

**Alpha** (as of February 2026).

- Discovery, pairing, RTSP session setup, and audio streaming are functional.
- PTP timing and multi-room group streaming are working (tested with HomePod Mini and Samsung TV).
- Many modules still contain `todo!()` stubs.
- The public API is **unstable**.

## Prerequisites

### macOS

- Xcode Command Line Tools: `xcode-select --install`
- Rust: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

No Homebrew packages are required. All native dependencies (FDK-AAC, ALAC, crypto) are either pure Rust or compile from vendored C source automatically.

### Linux (Debian/Ubuntu/Raspberry Pi OS)

```bash
sudo apt-get install build-essential pkg-config git curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Or run the setup script to install everything:

```bash
./setup-deps.sh
```

## Building

```bash
# Build all crates
cargo build --workspace

# Build in release mode
cargo build --workspace --release

# Run tests
cargo test --workspace
```

### Cross-compilation (for Raspberry Pi)

```bash
# Build for Pi 3/4/5/Zero 2 W (64-bit)
./utils/cross-compile.sh aarch64-unknown-linux-gnu

# Build for Pi 2/3/4/Zero 2 (32-bit)
./utils/cross-compile.sh armv7-unknown-linux-gnueabihf

# Build for Pi Zero/1 (ARMv6)
./utils/cross-compile.sh arm-unknown-linux-gnueabihf
```

## Quick Start

### 1. Discover devices on your network

```bash
cargo run -p airplay-discovery --example debug_devices
```

Shows all AirPlay devices with their IP addresses, model, features, AirPlay 2 / PTP support, and pairing requirements.

Options:
- `--raw-only` - Show only raw mDNS TXT records
- `--info` - Query each device's `/info` HTTP endpoint

### 2. Pair with a device

```bash
# Interactive - choose device and pairing method from a menu
cargo run -p airplay-pairing --example pair_with_device

# Auto-select by name, model, device ID, or IP
cargo run -p airplay-pairing --example pair_with_device -- --match "HomePod"

# Non-interactive transient pairing + encrypted RTSP session
cargo run -p airplay-pairing --example pair_with_device -- --match "HomePod" --mode transient-rtsp --pin 3939

# Auto-select via environment variable
AIRPLAY_DEVICE_MATCH="AudioAccessory5,1" cargo run -p airplay-pairing --example pair_with_device
```

Pairing methods available:
- **True Transient (Ed25519)** - No PIN, for devices with `pw=false`
- **SRP Transient (M1-M4)** - PIN required, no persistent registration
- **Full SRP (M1-M6)** - PIN required, registers your key with the device
- **Pair-Verify (TLV8)** - Uses a previously registered Ed25519 key
- **Pair-Verify (Raw 68-byte)** - For transient pairing sessions

Identity is persisted per-device at `.airplay_sender_identity_<device_id>.json`.

### 3. Play audio to a device

```bash
# AirPlay 1 / RAOP (no pairing required)
cargo run -p airplay-client --example play_audio -- <ip> <port> <audio-file> --airplay1

# AirPlay 2 (HomeKit pairing, NTP timing)
cargo run -p airplay-client --example play_audio -- <ip> <port> <audio-file> --airplay2

# AirPlay 2 with PTP timing (requires sudo for ports 319/320)
sudo cargo run -p airplay-client --example play_audio -- <ip> <port> <audio-file> --airplay2 --ptp
```

Supported audio formats: MP3, FLAC, WAV, AAC, ALAC, Ogg Vorbis, and more (via symphonia).

### 4. Play audio with PTP timing (HomePod)

```bash
# Uses BMCA yield flow: sender starts as master (Priority1=250), yields to
# HomePod (Priority1=248), then syncs as PTP slave
sudo cargo run -p airplay-client --example test_gptp -- <ip> 7000 <audio-file>
```

### 5. Multi-room group streaming

```bash
# Stream to multiple devices simultaneously (requires sudo for PTP)
sudo cargo run -p airplay-client --example test_group -- <ip1> <ip2> <audio-file>

# Non-standard ports supported (e.g., Samsung TV uses port 33330)
sudo cargo run -p airplay-client --example test_group -- <ip1>:7000 <ip2>:33330 <audio-file>
```

Tested with HomePod Mini + Samsung TV. Stereo pair members cannot be targeted individually.

### 6. Debug RTSP SETUP

```bash
cargo run -p airplay-client --example debug_setup -- <ip> <port>
```

Connects, pairs, and runs the two-phase RTSP SETUP handshake with verbose logging.

### 7. Terminal UI

```bash
cargo run -p airplay-tui

# With debug logging to file
cargo run -p airplay-tui -- --debug
cargo run -p airplay-tui -- --debug --log-file /tmp/airplay.log
```

Full terminal interface with device browser, file picker, playback controls, multi-room group management, and Bluetooth A2DP input (Linux only).

## Timing Synchronization: PTP vs NTP

This implementation supports two timing protocols for clock synchronization between sender and receiver.

### NTP-style Timing ✓ Working

**When to use**: AirPlay 1 devices and AirPlay 2 playback (including HomePod).

NTP timing uses a simple request-response protocol on an ephemeral UDP port negotiated during SETUP:
- Receiver sends timing requests (RTP PT=82) to the sender
- Sender responds with timestamps (RTP PT=83)
- Four-timestamp exchange calculates clock offset and round-trip delay
- Millisecond-level accuracy, sufficient for single-device playback

**Usage**:
```bash
cargo run -p airplay-client --example play_audio -- <ip> <port> <file> --airplay2
```

### PTP Timing (Multi-room) Working

**When to use**: AirPlay 2 multi-room synchronization and HomePod.

**Status**: Working with HomePod Mini and other PTP-capable devices using BMCA yield flow.

PTP (IEEE 1588) provides sub-millisecond synchronization required for multi-room audio:
- Uses UDP ports **319** (event) and **320** (general) - these are privileged ports requiring `sudo`
- Implements IEEE 1588 BMCA (Best Master Clock Algorithm) yield flow
- The sender starts as PTP master (Priority1=250), sends 3 Syncs + 2 Announces, then yields to the receiver (Priority1=248) and syncs as PTP slave
- Uses PT=87 sync packets (28 bytes, PTP clock time + master clock ID) for audio synchronization
- Required by HomePod and devices advertising `SupportsPTP` (feature bit 41)

**Usage**:
```bash
# Requires root/sudo for privileged ports 319/320
sudo cargo run -p airplay-client --example test_gptp -- <ip> 7000 <audio-file>
```

### Implementation Notes

- **NTP** is implemented in `crates/airplay-timing/src/ntp.rs` (working)
- **PTP** is implemented in `crates/airplay-timing/src/ptp.rs` (working)
- Both protocols implement the `TimingProtocol` trait for clock offset calculation
- The timing protocol is negotiated during RTSP SETUP Phase 1 (`timingProtocol: "NTP"` or `timingProtocol: "PTP"`)

## Real-time Audio on Raspberry Pi

The audio streamer is optimized for low-jitter playback on resource-constrained devices like the Raspberry Pi Zero 2 W:

- **Dedicated sender thread** with `clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME)` and `SCHED_FIFO` real-time priority achieves ~5 microsecond average jitter (vs ~1.5ms with async sleep)
- **Retransmit handling** for UDP packet loss — parses Apple's 8-byte compact retransmit request format and responds within 5ms
- **DSCP EF marking** on audio sockets for WiFi WMM Voice priority

### Required OS Tuning (run once after each boot)

These settings are critical for dropout-free audio streaming:

```bash
# 1. Set CPU governor to 'performance' (prevents frequency scaling jitter)
echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor

# 2. Grant real-time scheduling capability to the binary (avoids needing root)
sudo setcap cap_sys_nice+ep ~/airplay-tui

# 3. Reduce swap pressure (prevents memory thrashing on low-RAM Pis)
sudo sysctl -w vm.swappiness=10

# 4. Disable WiFi power management (prevents radio sleep between packets)
sudo iwconfig wlan0 power off
```

To make settings 1, 3, and 4 persist across reboots:

```bash
# /etc/rc.local or a systemd service
echo performance | tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor
sysctl -w vm.swappiness=10
iwconfig wlan0 power off
```

### Verify Real-time Priority is Working

After running with the capability set, check that SCHED_FIFO is active:

```bash
# While streaming, check the rt-sender thread
ps -eo pid,ni,rtprio,comm | grep airplay
# Should show rtprio=50 for the rt-sender thread
```

If `rtprio` shows `-`, the capability wasn't set correctly. Re-run `setcap` after each deploy.

### Recommended Runtime Options

```bash
# With render delay (gives receiver 200ms buffer for retransmit recovery)
./airplay-tui --render-delay 200

# With debug logging to diagnose jitter
./airplay-tui --debug --log-file ~/airplay-debug.log
```

### WiFi/Bluetooth Coexistence (Pi Zero 2 W)

The Pi Zero 2 W uses a shared WiFi/Bluetooth radio (BCM43430). When streaming
Bluetooth audio to AirPlay simultaneously, radio interference can cause crackling.

**Diagnosing the issue:**
```bash
cat /proc/net/wireless
# High 'retry' count (>1000) indicates WiFi/BT interference
```

**Built-in mitigation - Packet Bursting:**

The sender uses burst mode by default: instead of sending packets every ~8ms,
it sends 4 packets rapidly then waits ~32ms. This creates gaps for Bluetooth
to transmit cleanly, reducing collisions.

**Additional mitigations if crackling persists:**
- Use a USB Ethernet adapter (eliminates WiFi entirely)
- Move the Pi closer to the WiFi router
- Use SBC Bluetooth codec instead of aptX-HD (less BT bandwidth)
- Reduce other 2.4GHz interference (microwaves, other WiFi networks)

## Device-Specific Pairing

### HomePod (HomeKit Transient)

HomePod uses **HomeKit Transient pairing** which requires no user interaction:

```bash
cargo run -p airplay-client --example play_audio -- <ip> 7000 <file> --airplay2
```

- Uses PIN `3939` (hardcoded, no on-screen PIN)
- HKP=4 header (Transient mode)
- M1-M4 pair-setup only (no identity registration)
- No persistence - pairs fresh each connection

### Apple TV (HomeKit Normal with PIN)

Apple TV requires **HomeKit Normal pairing** with a user-entered PIN:

```bash
# 1. Trigger PIN display on Apple TV
curl -X POST http://<ip>:7000/pair-pin-start

# 2. Enter the 4-digit PIN shown on screen
cargo run -p airplay-client --example play_audio -- <ip> 7000 <file> --pin XXXX

# 3. Subsequent connections use saved identity (no PIN needed)
cargo run -p airplay-client --example play_audio -- <ip> 7000 <file> --airplay2 --device-id <device-id>
```

- Uses user-entered PIN displayed on Apple TV screen
- HKP=3 header (Normal mode)
- Full M1-M6 pair-setup (registers controller identity)
- Identity saved to `.airplay_sender_identity_<device_id>.json`
- Future connections use pair-verify (M1-M4) with saved identity

### Pairing Protocol Comparison

| Feature | HomeKit Transient | HomeKit Normal |
|---------|------------------|----------------|
| Used by | HomePod, 3rd-party | Apple TV |
| PIN | `3939` (fixed) | User enters from screen |
| HKP Header | 4 | 3 |
| Pair-Setup | M1-M4 only | Full M1-M6 |
| Identity | Not saved | Saved to disk |
| Subsequent | Fresh pairing | Pair-verify only |
| Format | TLV8 | TLV8 |
| SRP | SHA-512/3072-bit | SHA-512/3072-bit |

## Notes

- **HomePod**: Works with AirPlay 2 using either NTP timing (`--airplay2`) or PTP timing (`--airplay2 --ptp`). PTP is recommended for multi-room.
- **Apple TV**: Requires PIN pairing on first connection. Use `--pin XXXX` flag after triggering PIN with `/pair-pin-start`.
- **Transient pairing**: HomePod and HomeKit devices accept SRP transient pairing (M1-M4) with PIN `3939`. No pair-verify step is needed afterward.

## Architecture

```
airplay2-sender/
├── crates/
│   ├── airplay-core/        # Core types, traits, errors
│   ├── airplay-discovery/   # mDNS/Bonjour device discovery
│   ├── airplay-crypto/      # Cryptographic operations (SRP, ECDH, ChaCha20)
│   ├── airplay-pairing/     # HomeKit + FairPlay authentication
│   ├── airplay-rtsp/        # RTSP protocol + session management
│   ├── airplay-audio/       # Audio decoding, ALAC/AAC encoding, RTP
│   ├── airplay-timing/      # PTP (IEEE 1588) and NTP synchronization
│   ├── airplay-bluetooth/   # Bluetooth A2DP sink (Linux only)
│   ├── airplay-resampler/   # Audio sample rate conversion
│   ├── airplay-client/      # High-level client API + group streaming
│   └── airplay-tui/         # Terminal user interface
```

## Library Usage

The high-level client API (planned, not yet stable):

```rust
use airplay_client::{AirPlayClient, ClientBuilder};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut client = ClientBuilder::new()
        .airplay2()
        .buffer_duration_ms(2000)
        .build()?;

    let devices = client.discover(Duration::from_secs(5)).await?;

    if let Some(device) = devices.iter().find(|d| d.supports_airplay2()) {
        client.connect(device).await?;
        client.play_file("song.mp3").await?;
        client.wait_for_completion().await?;
    }

    Ok(())
}
```

For lower-level pairing control, use `airplay-pairing` directly:

```rust
use airplay_pairing::{PairingSession, PairingStep};

let mut session = PairingSession::new_transient();
let mut step = session.transient_pairing_start("3939")?;

loop {
    step = match step {
        PairingStep::Send(request) => {
            let response = send_pair_setup(request)?;
            session.transient_pairing_continue(response)?
        }
        PairingStep::Complete(keys) => {
            use_keys(keys);
            break;
        }
    };
}
```

## Dependencies

Key dependencies (all pure Rust except FDK-AAC which compiles from vendored C source):

- `tokio` - Async runtime
- `mdns-sd` - mDNS service discovery (pure Rust, no Avahi/Bonjour dependency)
- `symphonia` - Audio decoding (MP3, FLAC, WAV, AAC, ALAC, Ogg, etc.)
- `alac-encoder` - ALAC encoding (pure Rust)
- `fdk-aac` - AAC encoding (vendored C source, compiled via `cc`)
- `x25519-dalek`, `ed25519-dalek` - Elliptic curve crypto
- `chacha20poly1305` - AEAD encryption
- `num-bigint` - SRP big integer math
- `plist` - Binary plist encoding
- `rubato` - Audio sample rate conversion
- `ratatui` - Terminal UI framework
- `bluer` - BlueZ D-Bus interface for Bluetooth (Linux only)

## Bluetooth A2DP Sink (Raspberry Pi)

The TUI includes a Bluetooth tab (Linux only) that receives audio from Bluetooth devices (turntables, phones) and streams it to AirPlay speakers.

### Requirements

- Raspberry Pi running Raspberry Pi OS (Bookworm/Trixie)
- Bluetooth adapter (built-in or USB dongle)
- BlueALSA (bluez-alsa) for Bluetooth audio capture

### Setup (BlueALSA)

BlueALSA provides reliable A2DP audio capture with support for high-quality codecs like aptX HD.

```bash
# Install BlueALSA (if not already installed)
sudo apt-get install bluez-alsa-utils

# Disable PipeWire's Bluetooth support (if running) to avoid conflicts
mkdir -p ~/.config/wireplumber/wireplumber.conf.d
cat > ~/.config/wireplumber/wireplumber.conf.d/90-disable-bluez.conf << 'EOF'
wireplumber.profiles = {
  main = {
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
  }
}
EOF
systemctl --user restart wireplumber

# Enable and start BlueALSA
sudo systemctl enable bluealsa
sudo systemctl start bluealsa

# Ensure Bluetooth service is running
sudo systemctl enable bluetooth
sudo systemctl start bluetooth

# Make Pi discoverable and pairable
sudo bluetoothctl
[bluetooth]# power on
[bluetooth]# discoverable on
[bluetooth]# discoverable-timeout 0
[bluetooth]# pairable on
[bluetooth]# agent on
[bluetooth]# default-agent
```

### Pair a Bluetooth Device

```bash
sudo bluetoothctl
[bluetooth]# scan on
# Wait for device to appear (e.g., "Pro-Ject HD")

# Trust, pair and connect (replace XX:XX:XX:XX:XX:XX with device address)
[bluetooth]# trust XX:XX:XX:XX:XX:XX
[bluetooth]# pair XX:XX:XX:XX:XX:XX
# Enter PIN if prompted (some devices use 0000 or auto-accept)
[bluetooth]# connect XX:XX:XX:XX:XX:XX
[bluetooth]# exit
```

### Verify Audio Streaming

```bash
# Check BlueALSA sees the device
bluealsactl list-pcms
# Should show: /org/bluealsa/hci0/dev_XX_XX_XX_XX_XX_XX/a2dpsnk/source

# Test recording (while device is playing audio)
arecord -D bluealsa:DEV=XX:XX:XX:XX:XX:XX,PROFILE=a2dp \
  -f S24_LE -r 48000 -c 2 -d 5 /tmp/test.wav

# Verify the recording has audio content
file /tmp/test.wav
# Should show: WAVE audio, Microsoft PCM, 24 bit, stereo 48000 Hz
```

### Run TUI with Bluetooth

```bash
# Build with Bluetooth feature (cross-compile)
./utils/cross-compile.sh

# Or build on Pi directly
cargo build -p airplay-tui --features bluetooth --release

# Run
./airplay-tui
# Navigate to Bluetooth tab with Tab key
```

### Troubleshooting

**Device won't pair / authentication fails**:
- Put the device in pairing mode first (check device manual)
- Trust the device before pairing: `bluetoothctl trust XX:XX:XX:XX:XX:XX`
- Some devices (like turntables) may auto-pair when they detect the Pi

**Device pairs but no audio stream / "Capabilities blob size exceeded" error**:
- The default Debian BlueALSA package has a small capabilities buffer
- Build BlueALSA from source with the fix (see `docs/BLUETOOTH_ALSA_EVALUATION.md`)
- The device must be **actively playing audio** - for turntables, the needle must be on a spinning record

**No PCM in bluealsactl list-pcms**:
- Check the device is connected: `bluetoothctl info XX:XX:XX:XX:XX:XX`
- Ensure BlueALSA is running: `sudo systemctl status bluealsa`
- Check for errors: `journalctl -u bluealsa -f`
- Reconnect the device: `bluetoothctl disconnect XX:XX:XX:XX:XX:XX && bluetoothctl connect XX:XX:XX:XX:XX:XX`

**"UUID already registered" warnings**:
- Both PipeWire and BlueALSA are trying to handle Bluetooth audio
- Disable PipeWire's bluez monitor (see setup instructions above)

**Poor audio quality / dropouts**:
- Apply all OS tuning from the "Real-time Audio on Raspberry Pi" section above
- Move the Pi closer to the Bluetooth device
- Check codec: `bluealsactl codec XX:XX:XX:XX:XX:XX`
- Reduce memory pressure: `sudo sysctl -w vm.swappiness=10`

**Pi not discoverable from the Bluetooth device**:
- Set infinite discoverable timeout:
  ```bash
  bluetoothctl discoverable-timeout 0
  bluetoothctl discoverable on
  ```
- Some devices require the Pi to initiate the connection instead

### Bluetooth Audio Codecs

Bluetooth audio quality depends on the codec negotiated between devices:

| Codec | Bitrate | Quality | Notes |
|-------|---------|---------|-------|
| LDAC | 990 kbps | Best | Sony proprietary, rare on non-Sony devices |
| aptX-HD | 576 kbps | Excellent | Common on high-end turntables and speakers |
| aptX | 352 kbps | Very Good | Common on mid-range devices |
| AAC | 250 kbps | Good | Common on Apple devices |
| SBC | 328 kbps | Baseline | Universal fallback, always works |

To check which codec is being used:
```bash
bluealsactl codec XX:XX:XX:XX:XX:XX
```

The Pro-Ject T1 BT turntable supports aptX-HD for high-quality vinyl streaming.

### Building BlueALSA from Source (for aptX HD support)

The default Debian BlueALSA package may lack aptX-HD support or have buffer size issues with some devices. Build from source for full codec support:

```bash
# Install dependencies
sudo apt install -y git automake libtool pkg-config libasound2-dev \
  libbluetooth-dev libdbus-1-dev libglib2.0-dev libsbc-dev \
  libfdk-aac-dev libopenaptx-dev

# Clone and build
cd ~
git clone https://github.com/arkq/bluez-alsa.git
cd bluez-alsa

# Fix capabilities buffer for devices with large A2DP capabilities
sed -i 's/a2dp_opus_pw_t opus_pw;/a2dp_opus_pw_t opus_pw;\n\tuint8_t _padding[64];/' src/shared/a2dp-codecs.h

# Build with aptX HD support
autoreconf --install
./configure --enable-aptx --enable-aptx-hd --enable-aac --enable-systemd --with-libopenaptx
make -j$(nproc)

# Install
sudo systemctl stop bluealsa
sudo make install
sudo systemctl daemon-reload
sudo systemctl enable --now bluealsa
```

See `docs/BLUETOOTH_ALSA_EVALUATION.md` for detailed build instructions and troubleshooting.

## Protocol References

- shairport-sync (C) - Production AirPlay 2 receiver
- openairplay documentation


## License

Copyright (c) 2026 Lucas McGartland

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for details.

SPDX-License-Identifier: `GPL-3.0-or-later`
