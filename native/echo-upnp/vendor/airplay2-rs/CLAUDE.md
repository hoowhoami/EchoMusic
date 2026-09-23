# CLAUDE.md - AirPlay 2 Sender Implementation Guide

## Project Overview

Building an open-source AirPlay 2 audio transmitter (sender) in Rust. The goal is to stream audio to Apple devices (Apple TV, HomePod, AirPlay-enabled speakers) without requiring Apple's MFi hardware licensing.

**Key constraint:** Use HomeKit transient pairing to bypass MFi requirements. This works because devices with feature bit 51 (SupportsUnifiedPairSetupAndMFi) WITHOUT bit 26 (Authentication_8) accept software-only authentication.

**PTP Timing:** Works via BMCA yield flow (Mac-style). The sender sends 3 Syncs with Priority1=250, yields to HomePod (Priority1=248), then syncs as slave. Uses PT=87 sync packets (28 bytes, PTP clock time + master clock ID) instead of PT=84 NTP sync. Test with: `sudo cargo run --example test_gptp -- <ip> 7000 <audio-file>`

## Spec Reference

**Read `AIRPLAY_2_SPEC.md` in the project root before implementing protocol details.** It contains:
- Complete protocol flows with message formats
- Cryptographic algorithm parameters
- Binary plist field names and values
- RTP packet structures
- Timing protocol details

When in doubt, check the spec first.

## Architecture

```
airplay-core       → Foundation types, traits, errors (NO dependencies)
airplay-crypto     → All cryptographic operations (depends on: core)
airplay-discovery  → mDNS device discovery (depends on: core)
airplay-pairing    → HomeKit + FairPlay auth (depends on: core, crypto)
airplay-rtsp       → RTSP protocol (depends on: core, crypto, pairing)
airplay-audio      → Audio encoding + RTP (depends on: core, crypto)
airplay-timing     → PTP/NTP sync (depends on: core)
airplay-client     → High-level API (depends on: all above)
```

## Implementation Order

Follow this order strictly - each phase builds on the previous:

### Phase 1: `airplay-core`
```
1. src/error.rs      - Error types with thiserror
2. src/features.rs   - 64-bit feature bitmask parsing (CRITICAL)
3. src/device.rs     - DeviceId (MAC), Version parsing
4. src/codec.rs      - AudioCodec enum, AudioFormat struct
5. src/stream.rs     - StreamType, StreamConfig
```

### Phase 2: `airplay-crypto`
```
1. src/tlv.rs        - TLV8 encode/decode (simple, needed early)
2. src/hkdf.rs       - HKDF-SHA512 key derivation
3. src/curve25519.rs - ECDH key exchange
4. src/ed25519.rs    - Digital signatures
5. src/chacha.rs     - ChaCha20-Poly1305 AEAD
6. src/srp.rs        - SRP-6a (3072-bit) - MOST COMPLEX
7. src/keys.rs       - SessionKeys wrapper types
8. src/aes.rs        - AES-128-CBC (legacy, low priority)
```

### Phase 3: `airplay-discovery`
```
1. src/parser.rs     - TXT record parsing
2. src/traits.rs     - Discovery trait
3. src/browser.rs    - mDNS implementation
```

### Phase 4: `airplay-pairing`
```
1. src/traits.rs     - Transport trait for mocking
2. src/pair_verify.rs - Curve25519 + Ed25519 (M1-M4)
3. src/pair_setup.rs  - SRP flow (M1-M6)
4. src/fairplay.rs    - FairPlay setup (if needed)
5. src/session.rs     - Orchestration
```

### Phase 5: `airplay-rtsp`
```
1. src/plist_codec.rs - Binary plist serde
2. src/request.rs     - RTSP request building
3. src/response.rs    - RTSP response parsing
4. src/connection.rs  - TCP + encryption
5. src/session.rs     - Two-phase SETUP state machine
```

### Phase 6: `airplay-audio` + `airplay-timing` (parallel)
```
Audio: buffer.rs → rtp.rs → encoder.rs → decoder.rs → streamer.rs
Timing: clock.rs → ntp.rs → ptp.rs
```

### Phase 7: `airplay-client`
```
Integration layer - tie everything together
```

## Coding Standards

### General
- Use `todo!()` for unimplemented functions (already scaffolded)
- Replace ONE `todo!()` at a time, run tests, commit
- Keep functions small and focused
- Prefer returning `Result<T>` over panicking

### Error Handling
```rust
// Use the crate's error types, not anyhow in library code
use crate::error::{Error, Result};

// Propagate with ?
pub fn do_thing() -> Result<Thing> {
    let data = parse_data()?;
    Ok(Thing::new(data))
}
```

### Testing Pattern
```rust
#[cfg(test)]
mod tests {
    use super::*;

    mod function_name {
        use super::*;

        #[test]
        fn describes_behavior() {
            // Arrange
            let input = ...;
            
            // Act
            let result = function_name(input);
            
            // Assert
            assert_eq!(result, expected);
        }
    }
}
```



### Real Device Testing
Once discovery works, capture TXT records from real devices:
```bash
# macOS
dns-sd -B _airplay._tcp local.
dns-sd -L "Device Name" _airplay._tcp local.

# Linux
avahi-browse -r _airplay._tcp
```

### Known Apple TV 4K Features
```
features=0x445F8A00,0x1C340
srcvers=366.0
model=AppleTV5,3
```


## Debugging Tips

### Enable Tracing
```rust
// In tests or examples:
tracing_subscriber::fmt()
    .with_max_level(tracing::Level::DEBUG)
    .init();
```

### Hex Dump Packets
```rust
fn hex_dump(data: &[u8]) -> String {
    data.iter().map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ")
}
```

## Quick Reference Commands

Get the IP addresses of the AirPlay devices on the network using the debug_devices

```bash
cargo run -p airplay-discovery --example debug_devices
```

```bash
# Run all tests
cargo test --workspace

# Run single crate tests
cargo test -p airplay-core

# Run specific test
cargo test -p airplay-crypto srp::tests::client_server_roundtrip

# Check without building
cargo check --workspace

# Format code
cargo fmt --all

# Lint
cargo clippy --workspace

# Cross-compile for Pi Zero
./utils/cross-compile.sh

# Setup deps on Pi (native build)
./utils/setup-deps.sh
```

## Cross-Compilation (Raspberry Pi)

Building on a Pi Zero is slow. Use cross-compilation from a faster machine instead.

### Prerequisites
- Docker installed and running
- Rust toolchain on your dev machine

### Quick Start
```bash
# Pi Zero (ARMv6) - builds and auto-deploys to pi@raspberrypi.local
./utils/cross-compile.sh
```

The script automatically copies binaries to `pi@raspberrypi.local` using sshpass.

### Run on Pi
```bash
ssh pi@raspberrypi.local
./airplay-tui
```

### Manual Deploy (if needed)
```bash
scp target/arm-unknown-linux-gnueabihf/release/airplay-* pi@raspberrypi.local:~/
```

### Target Reference
| Device | Architecture | Target |
|--------|-------------|--------|
| Pi Zero, Zero W, 1 | ARMv6 | `arm-unknown-linux-gnueabihf` |
| Pi 2, 3, 4, Zero 2 W | ARMv7 | `armv7-unknown-linux-gnueabihf` |
| Pi 3, 4, 5 (64-bit OS) | AArch64 | `aarch64-unknown-linux-gnu` |


Note: Avoid builds on Pi Zero due to limited RAM and CPU.

## Definition of Done (per function)

1. ✅ All `todo!()` replaced with implementation
2. ✅ All tests in the module pass
3. ✅ No clippy warnings
4. ✅ Code formatted with rustfmt
5. ✅ Public items have doc comments
6. ✅ Crypto code uses zeroize for secrets

## When Stuck

1. Check `AIRPLAY_2_SPEC.md` for protocol details
2. Use real device testing with logs
