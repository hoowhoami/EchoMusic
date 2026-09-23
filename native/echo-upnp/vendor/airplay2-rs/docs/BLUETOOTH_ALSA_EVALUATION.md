# Bluetooth Audio via ALSA/BlueALSA - Setup Guide

## Overview

This document describes using BlueALSA for Bluetooth audio capture from A2DP source devices (turntables, phones, etc.) for streaming to AirPlay speakers.

## Status: ✅ IMPLEMENTED

BlueALSA is now the **primary** Bluetooth audio capture method for airplay-tui. It successfully captures aptX HD audio (48kHz/24-bit) from devices like the Pro-Ject HD turntable and resamples to 44.1kHz for AirPlay compatibility.

**Capture command:**
```bash
arecord -D bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp -f S24_LE -r 48000 -c 2 output.wav
```

---

## Critical Fix #1: RTP Payload Type Check

### The Problem

Some Bluetooth A2DP source devices (including the Pro-Ject HD turntable) use non-standard RTP payload type values. BlueALSA's default configuration rejects packets with payload types below 96, causing **silent audio** (all zeros) even though the connection appears working.

**Symptoms:**
- BlueALSA logs show constant errors: `Unsupported RTP payload type: X` (where X is 0-95)
- Audio capture returns only zeros/silence
- Bluetooth connection shows as connected
- Transport shows as "Running"

### The Solution

Disable the RTP payload type check by patching `src/rtp.c`:

```c
// Change this line (around line 61):
#if ENABLE_PAYLOADCHECK

// To this:
#if 0 // DISABLED: ENABLE_PAYLOADCHECK
```

Or configure with `--disable-payloadcheck`:

```bash
./configure --disable-payloadcheck --enable-aac --enable-aptx --enable-aptx-hd --with-libopenaptx
```

### Quick Fix (if BlueALSA source is already on the Pi)

```bash
cd ~/bluez-alsa

# Patch the source
sed -i 's/#if ENABLE_PAYLOADCHECK/#if 0 \/\/ DISABLED: ENABLE_PAYLOADCHECK/g' src/rtp.c

# Rebuild (assumes already configured)
make -j2

# Install
sudo systemctl stop bluealsa
sudo cp src/bluealsad /usr/bin/bluealsad
sudo systemctl start bluealsa

# Reconnect Bluetooth device
bluetoothctl disconnect 53:4A:52:FC:03:9F
bluetoothctl connect 53:4A:52:FC:03:9F
```

### Verification

```bash
# Check logs - should NOT see "Unsupported RTP payload type" errors
journalctl -u bluealsa --since "1 minute ago" | grep -i payload

# Test audio capture - should show varying values, not just 0/-1
arecord -D bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp -f S16_LE -r 48000 -c 2 -d 2 /tmp/test.wav
head -c 200 /tmp/test.wav | od -A x -t d2 | tail -10
```

### Note on Persistence

This fix must be reapplied if BlueALSA is updated via apt. After system updates, check if the issue returns and rebuild if necessary.

---

## Critical Fix #2: Capabilities Buffer Overflow

### The Problem

The Debian-packaged BlueALSA fails with the Pro-Ject HD turntable:

```
Capabilities blob size exceeded: 40 > 24
```

The turntable sends 40 bytes of A2DP capabilities data, but BlueALSA's `a2dp_t` union in `src/shared/a2dp-codecs.h` is only ~24 bytes (the largest member is `a2dp_opus_pw_t` at ~21 bytes plus padding).

### The Solution

Build BlueALSA from source with a padding field added to the `a2dp_t` union:

```c
typedef union a2dp {
    a2dp_sbc_t sbc;
    a2dp_mpeg_t mpeg;
    // ... other codecs ...
    a2dp_opus_pw_t opus_pw;
    uint8_t _padding[64];  // ADD THIS LINE - ensures 64-byte minimum
} a2dp_t;
```

### Build Instructions

```bash
# Install dependencies
sudo apt install -y git automake libtool pkg-config libasound2-dev \
  libbluetooth-dev libdbus-1-dev libglib2.0-dev libsbc-dev \
  libfdk-aac-dev libopenaptx-dev

# Clone and patch
cd ~
git clone https://github.com/arkq/bluez-alsa.git
cd bluez-alsa

# PATCH 1: Add padding to a2dp_t union (fixes capabilities buffer overflow)
sed -i 's/a2dp_opus_pw_t opus_pw;/a2dp_opus_pw_t opus_pw;\n\tuint8_t _padding[64];  \/* Ensure minimum 64-byte buffer for large capabilities *\//' src/shared/a2dp-codecs.h

# PATCH 2: Disable RTP payload type check (fixes silent audio with some devices)
sed -i 's/#if ENABLE_PAYLOADCHECK/#if 0 \/\/ DISABLED: ENABLE_PAYLOADCHECK/g' src/rtp.c

# Build with aptX HD support
autoreconf --install
./configure --enable-aptx --enable-aptx-hd --enable-aac --enable-systemd --with-libopenaptx
make -j$(nproc)

# Install
sudo systemctl stop bluealsa
sudo make install
sudo cp misc/systemd/bluealsa.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bluealsa
```

---

## Current State

### What's Already Installed

| Component | Status |
|-----------|--------|
| `bluealsa` | Installed at `/usr/bin/bluealsa` |
| `bluealsa-aplay` | Installed at `/usr/bin/bluealsa-aplay` |
| ALSA config | `/etc/alsa/conf.d/20-bluealsa.conf` present |
| systemd service | `/usr/lib/systemd/system/bluealsa.service` (disabled) |

### BlueALSA Service Configuration

The existing service file (`/usr/lib/systemd/system/bluealsa.service`) is already configured with:

```bash
ExecStart=/usr/bin/bluealsa -S -p a2dp-source -p a2dp-sink
```

This enables both A2DP Source (receiving audio) and A2DP Sink (sending audio).

## The Conflict

**PipeWire's bluez5 plugin and BlueALSA cannot run simultaneously.**

Both register A2DP endpoints with BlueZ via D-Bus. When PipeWire's bluez5 plugin is active, it claims the Bluetooth audio endpoints, preventing BlueALSA from working.

## Option 1: Disable PipeWire's BlueZ Monitor (Recommended)

Keep PipeWire for other audio tasks but disable only the Bluetooth functionality.

### Steps

1. **Create WirePlumber config to disable bluez monitor:**

```bash
cat > ~/.config/wireplumber/wireplumber.conf.d/90-disable-bluez.conf << 'EOF'
# Disable PipeWire's Bluetooth audio support
# This allows BlueALSA to handle Bluetooth instead

wireplumber.profiles = {
  main = {
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
  }
}
EOF
```

2. **Restart WirePlumber:**
```bash
systemctl --user restart wireplumber
```

3. **Enable and start BlueALSA:**
```bash
sudo systemctl enable bluealsa
sudo systemctl start bluealsa
```

4. **Verify BlueALSA is running:**
```bash
systemctl status bluealsa
```

### Capture Audio

Once BlueALSA is running and the turntable is connected:

```bash
# List available BlueALSA PCM devices
bluealsa-cli list-pcms

# Or check with arecord
arecord -L | grep bluealsa

# Capture audio from the turntable
arecord -D bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp -f S24_LE -r 48000 -c 2 test.wav
```

### Integration with AirPlay TUI

Update the Bluetooth capture code to use ALSA directly:

```rust
// Instead of PipeWire's pw-cat, use ALSA's arecord or libalsa
let device = "bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp";
```

## Option 2: Disable PipeWire Entirely

If PipeWire isn't needed for other audio tasks:

```bash
# Stop and disable PipeWire
systemctl --user stop pipewire pipewire-pulse wireplumber
systemctl --user disable pipewire pipewire-pulse wireplumber

# Enable and start BlueALSA
sudo systemctl enable bluealsa
sudo systemctl start bluealsa
```

## Option 3: Use BlueALSA with PipeWire as ALSA Backend

Configure PipeWire to use BlueALSA's ALSA devices as a source:

1. Disable PipeWire's native bluez5 support (as in Option 1)
2. Create a PipeWire source that reads from the BlueALSA ALSA device

This is more complex but keeps PipeWire in the audio path.

## Comparison

| Aspect | PipeWire bluez5 | BlueALSA |
|--------|-----------------|----------|
| **Maturity** | Newer, more bugs | Mature, stable |
| **Transport handling** | Complex (empty transport issue) | Direct, simple |
| **A2DP Source support** | Inconsistent | Well-tested |
| **API** | PipeWire native | ALSA PCM |
| **Integration** | Automatic with WirePlumber | Manual device specification |
| **Codec support** | Same (aptX HD, etc.) | Same |

## Recommended Approach

**Use Option 1: Disable PipeWire's bluez monitor and use BlueALSA**

Reasons:
1. BlueALSA is already installed and configured
2. BlueALSA has more mature A2DP Source support
3. Direct ALSA access is simpler than debugging PipeWire's transport issues
4. Keeps PipeWire available for other audio routing needs

## Implementation Checklist

- [x] Create `~/.config/wireplumber/wireplumber.conf.d/90-disable-bluez.conf`
- [x] Restart WirePlumber: `systemctl --user restart wireplumber`
- [x] Build BlueALSA from source with capabilities buffer fix (see above)
- [x] Start BlueALSA: `sudo systemctl enable --now bluealsa`
- [x] Verify turntable connects and audio is available
- [x] Test capture: `arecord -D bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp -f S24_LE -r 48000 -c 2 -d 5 test.wav`
- [x] Update TUI code to use ALSA for Bluetooth capture (completed January 2026)

## BlueALSA Commands Reference

```bash
# List connected devices and their PCMs
bluealsa-cli list-pcms

# Monitor BlueALSA events
bluealsa-cli monitor

# Get codec info
bluealsa-cli codec 53:4A:52:FC:03:9F

# Stream audio to speakers (for testing sink)
bluealsa-aplay 53:4A:52:FC:03:9F

# ALSA device names
# Capture: bluealsa:DEV=XX:XX:XX:XX:XX:XX,PROFILE=a2dp
# Playback: bluealsa:DEV=XX:XX:XX:XX:XX:XX,PROFILE=a2dp
```

## Implementation Details

The airplay-bluetooth crate now uses ALSA directly for Bluetooth audio capture:

**Key files:**
- `crates/airplay-bluetooth/src/alsa_capture.rs` - ALSA PCM capture with HD format support
- `crates/airplay-bluetooth/src/setup.rs` - BlueALSA service checks
- `crates/airplay-tui/src/bluetooth_helper.rs` - BlueALSA helper functions

**Features:**
- Captures at native 48kHz/S24 for aptX HD devices
- Resamples to 44.1kHz using `rubato` crate for AirPlay compatibility
- Converts 24-bit samples to 16-bit for the AirPlay pipeline
- Falls back to 44.1kHz/S16 for standard Bluetooth codecs

```rust
// HD capture config (aptX HD, LDAC)
let config = CaptureConfig::for_bluealsa_hd(&device_address);
// Captures at 48kHz/S24, outputs 44.1kHz/S16

// Standard capture config (SBC, aptX, AAC)
let config = CaptureConfig::for_bluealsa(&device_address);
// Captures at 44.1kHz/S16 directly
```

## Risks and Considerations

1. **Device reconnection** - BlueALSA may need the device MAC hardcoded; dynamic discovery requires `bluealsa-cli`

2. **Service ordering** - BlueALSA must start after bluetooth.service

3. **Permissions** - BlueALSA runs as root by default; user access requires D-Bus policy configuration

4. **Codec negotiation** - BlueALSA handles codec negotiation with the remote device; aptX HD should work if supported

## Verification

### Confirm No Capabilities Errors

```bash
journalctl -u bluealsa | grep -i "capabilities"
# Should return nothing (no errors)
```

### Confirm PCM Available

```bash
bluealsactl list-pcms
# Should show: /org/bluealsa/hci0/dev_53_4A_52_FC_03_9F/a2dpsnk/source
```

### Confirm Audio Has Content

```bash
arecord -D bluealsa:DEV=53:4A:52:FC:03:9F,PROFILE=a2dp -d 3 -f S24_LE -r 48000 -c 2 - | od -A x -t x1 | head -10
# Should show varying bytes, not all zeros
```

## Troubleshooting

### Audio Capture Returns Silence (All Zeros)

**Symptom:** `arecord` works but captured audio is all zeros or values like 0/-1.

**Diagnosis:**
```bash
# Check for RTP payload errors
journalctl -u bluealsa --since "1 minute ago" | grep -i "payload type"
```

If you see `Unsupported RTP payload type: X` errors, apply the RTP payload check fix (see Critical Fix #1 above).

### "Capabilities blob size exceeded" Error

**Symptom:** BlueALSA refuses to connect with error about capabilities size.

**Diagnosis:**
```bash
journalctl -u bluealsa | grep -i "capabilities"
```

If you see size exceeded errors, apply the capabilities buffer fix (see Critical Fix #2 above).

### Volume Meter Stuck at Zero in TUI

If the airplay-tui Bluetooth page shows samples being received but the volume meter stays at 0:

1. Check if audio is actually silent: `arecord -D bluealsa:... -d 2 /tmp/test.wav && od -t d2 /tmp/test.wav | head`
2. If samples are all 0/-1, apply the RTP payload check fix
3. Reconnect the Bluetooth device after restarting BlueALSA

### After System Update

If Bluetooth audio stops working after an apt upgrade:

```bash
# Check if bluealsad was replaced
strings /usr/bin/bluealsad | grep -i "payload type"
# If "Unsupported RTP payload type" appears, the patch was overwritten

# Rebuild and reinstall from source
cd ~/bluez-alsa
sudo systemctl stop bluealsa
sudo cp src/bluealsad /usr/bin/bluealsad
sudo systemctl start bluealsa
```

---

## Rollback

If issues occur, reinstall the Debian package:

```bash
sudo systemctl stop bluealsa
sudo apt install --reinstall bluez-alsa-utils
sudo systemctl start bluealsa
```

## System Info Reference

| Item | Value |
|------|-------|
| Device | Pro-Ject HD turntable |
| MAC Address | 53:4A:52:FC:03:9F |
| Codec | aptX HD (may negotiate aptX depending on connection) |
| Format | S24_LE, 48000 Hz, stereo |
| BlueALSA Source | Built from `https://github.com/arkq/bluez-alsa` |

### Required Modifications

| Patch | File | Description |
|-------|------|-------------|
| Capabilities buffer | `src/shared/a2dp-codecs.h` | Add `uint8_t _padding[64]` to `a2dp_t` union |
| RTP payload check | `src/rtp.c` | Change `#if ENABLE_PAYLOADCHECK` to `#if 0` |

Both patches are required for reliable operation with the Pro-Ject HD turntable.
