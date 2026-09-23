# AirPlay 2 Audio Sender Protocol — Unofficial Implementer RFC (Draft)

> **Scope:** Audio sender (transmitter) implementation (Wi‑Fi LAN).  
> **Nongoals:** AirPlay video/mirroring, peer‑to‑peer AirPlay ("_airplay-p2p"), full HomeKit accessory semantics.  
> **Disclaimer:** Apple does not publish a public AirPlay 2 protocol RFC. This document is derived from public reverse‑engineering notes and open-source implementations and should be treated as an interoperability guide, not a normative Apple spec.

---

## Status of This Memo

This memo provides information for implementers. It does not specify an Internet standard of any kind.

## Abstract

AirPlay 2 extends AirPlay with buffered audio streaming, multi-room synchronization, and authenticated encryption on the control plane. For sender implementations, the critical path is: Bonjour discovery of receivers and capabilities; pairing/session encryption establishment (commonly HomeKit-based pairing); RTSP-like control exchanges using binary plists; two-stage SETUP to negotiate timing/event and audio streams; RTP audio transport for realtime (PT=96) and buffered (PT=103); and clock synchronization (typically PTP for multi-room). This document uses RFC2119-style keywords (MUST/SHOULD/MAY) to clarify requirements and adds practical HomePod pairing/access-control guidance.

## Conventions and Terminology

### Requirements Language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" are to be interpreted as described in RFC 2119.

### Terms

- **Sender:** The device/software initiating playback (this document's focus).
- **Receiver:** AirPlay-capable sink (HomePod, Apple TV, third-party speaker, etc.).
- **Controller connection:** RTSP-like TCP connection to the receiver's AirPlay service.
- **Realtime stream:** Low-latency audio stream (observed: ALAC, RTP PT=96).
- **Buffered stream:** Buffered audio stream (observed: AAC, RTP PT=103).
- **Bonjour:** mDNS + DNS-SD (service discovery).
- **HKP:** "HomeKit-based pairing" (SRP/Curve25519/Ed25519 + ChaCha20-Poly1305 framing).

---

## 1. Discovery and Capability Advertisement (Bonjour / mDNS)

### 1.1 Transport and Addressing

Receivers advertise services using DNS-SD over mDNS:
- IPv4 multicast: 224.0.0.251, UDP 5353
- IPv6 multicast: ff02::fb, UDP 5353

### 1.2 Service Types

Receivers commonly advertise:

| Service | Typical Purpose | Notes |
|---|---|---|
| `_airplay._tcp.local.` | AirPlay control endpoint | Carries `features`, `model`, `srcvers`, keys/IDs, etc. |
| `_raop._tcp.local.` | AirTunes/RAOP audio endpoint | Legacy compatibility + extra hints (codec/encryption/password). |
| `_airplay-p2p._tcp.local.` | Peer-to-peer (AWDL) | Out of scope in this RFC. |

**Port note:** The `_airplay._tcp` port MUST be obtained from SRV and MUST NOT be hardcoded (7000 is common but not guaranteed).

### 1.3 Sender Discovery Procedure

A sender SHOULD:

1. Browse PTR for `_airplay._tcp.local.`
2. Resolve SRV (target host + port)
3. Fetch TXT
4. Resolve A/AAAA for target host
5. Optionally browse `_raop._tcp.local.` for fallback/legacy and supplemental TXT hints

### 1.4 TXT Keys: `_airplay._tcp` (Complete)

TXT keys are extensible. A sender MUST ignore unknown keys and MUST NOT assume presence of all keys.

| Key | ToDict | Type | Meaning (Observed) |
|---|---|---|---|
| `deviceid` | deviceID | string | MAC-like identifier |
| `model` | deviceModel | string | Model identifier (e.g., `AudioAccessory1,1`) |
| `srcvers` | airPlayVersion | string | AirPlay software version string used in observed gating logic |
| `protovers` | protocolVersion | string | Protocol version |
| `features` | features | hex | 64-bit capability mask encoded as `0xLOWER,0xUPPER` |
| `rsf` | requiredSenderFeatures | hex | Required sender features bitmask |
| `flags` | systemFlags | hex | "system flags" bitmask (commonly treated as 64-bit) |
| `pk` | publicKey | hex | Public key used by pairing flows on some devices |
| `pi` | publicCUAirPlayPairingIdentity | UUID-ish | Pairing identity (varies by device) |
| `psi` | publicCUSystemPairingIdentity | UUID-ish | System pairing identity (varies by device) |
| `gid` | groupUUID | UUID | Group identifier (multi-room) |
| `gpn` | groupPublicName | string | Group public name |
| `igl` | isGroupLeader | 0/1 | "Is group leader" (multi-room) |
| `gcgl` | groupContainsDiscoverableLeader | 0/1 | Group contains discoverable leader |
| `pgid` | parentGroupUUID | UUID | Parent group UUID |
| `pgcgl` | parentGroupContainsDiscoverableLeader | 0/1 | Parent group contains discoverable leader |
| `tsid` | tightSyncUUID | UUID | Tight sync UUID |
| `acl` | accessControlLevel | int | Access control level (receiver policy) |
| `hkid` | homeKitHomeUUID | UUID-ish | HomeKit home UUID |
| `hgid` | homeGroupUUID | UUID-ish | Home group UUID |
| `hmid` | householdID | UUID-ish | Household ID |
| `fv` | firmwareVersion | string | Firmware version |
| `osvers` | OSVersion | string | OS version |
| `btaddr` | bluetoothAddress | string | Bluetooth address |
| `manufacturer` | manufacturer | string | Manufacturer |
| `serialNumber` | serialNumber | string | Serial number |

### 1.5 TXT Keys: `_raop._tcp` (Selected)

`_raop._tcp` may include codec and legacy encryption hints:

| Key | ToDict | Type | Meaning (Observed) |
|---|---|---|---|
| `cn` | compressionTypes | bitlist | Codec capabilities |
| `sr` | — | int | Sample rate |
| `ss` | — | int | Sample size |
| `ch` | — | int | Channels |
| `et` | encryptionTypes | bitlist | Encryption type hint (legacy / compatibility) |
| `pw` | password | boolean | Password-protected hint (legacy / compatibility) |
| `md` | metadataTypes | bitlist | Metadata types |
| `am` | deviceModel | string | Device model |
| `tp` | transportTypes | string | Transport types |
| `vn` | airTunesProtocolVersion | string | AirTunes protocol version |
| `vs` | airPlayVersion | string | AirPlay version |
| `ov` | OSVersion | string | OS version |
| `vv` | vodkaVersion | int | Vodka version |
| `da` | rfc2617DigestAuthKey | boolean | RFC2617 digest auth key |
| `ft` | features | hex | Features (duplicate of `_airplay._tcp`) |
| `sf` | systemFlags | hex | System flags |
| `pk` | publicKey | string | Public key |

A robust sender SHOULD consult both `_airplay._tcp` and `_raop._tcp` when present.

---

## 2. Capability Model (`features` and version gates)

### 2.1 `features` Encoding

`features` is a 64-bit bitmask encoded as `0xLOWER,0xUPPER`, representing the 64-bit value `0xUPPERLOWER`.

Example:
- `features=0x40000a00,0x80300` represents `0x0008030040000a00`.

Senders MUST:
- parse both 32-bit words,
- treat missing/invalid values as "unknown capabilities," and
- fall back conservatively.

### 2.2 Complete Feature Bits Table

| Bit | Property | Condition | Description |
|-----|----------|-----------|-------------|
| 0 | SupportsAirPlayVideoV1 | | AirPlay video v1 |
| 1 | SupportsAirPlayPhoto | | Photo streaming |
| 5 | SupportsAirPlaySlideshow | | Slideshow support |
| 7 | SupportsAirPlayScreen | | Screen mirroring |
| 9 | SupportsAirPlayAudio | | Audio streaming (required) |
| 11 | AudioRedundant | | Audio redundancy support |
| 12 | FPSAPv2pt5_AES_GCM | | FairPlay secure auth supported |
| 13 | PhotoCaching | | Photo preloading supported |
| 14 | Authentication_4 | | FairPlay authentication |
| 15 | MetadataFeatures_1 | | Artwork (bit 1 of MetadataFeatures) |
| 16 | MetadataFeatures_2 | | Progress (bit 2 of MetadataFeatures) |
| 17 | MetadataFeatures_0 | | Text (bit 0 of MetadataFeatures) |
| 18 | AudioFormats_0 | | Audio format support bit 0 |
| 19 | AudioFormats_1 | | Audio format bit 1 (required for AirPlay 2) |
| 20 | AudioFormats_2 | | Audio format bit 2 (required for AirPlay 2) |
| 21 | AudioFormats_3 | | Audio format support bit 3 |
| 22 | — | | Unknown |
| 23 | Authentication_1 | | RSA authentication (legacy) |
| 24 | — | | Unknown |
| 25 | — | | Unknown |
| 26 | HasUnifiedAdvertiserInfo | | Unified advertiser info (MFi auth trigger) |
| 27 | SupportsLegacyPairing | | Legacy pairing support |
| 28 | — | | Unknown |
| 29 | — | | Unknown |
| 30 | RAOP | | RAOP supported on this port (no separate AirTunes service needed) |
| 32 | IsCarPlay / SupportsVolume | `!32` for volume | CarPlay mode (disables volume) |
| 33 | SupportsAirPlayVideoPlayQueue | | Video play queue |
| 34 | SupportsAirPlayFromCloud | `34 && flags_6` | Cloud playback |
| 35 | SupportsTLS_PSK | | TLS pre-shared key |
| 38 | SupportsUnifiedMediaControl | | Unified media control |
| 39 | — | | Unknown |
| 40 | SupportsBufferedAudio | `srcvers >= 354.54.6 && 40` | Buffered audio (AirPlay 2, multi-room) |
| 41 | SupportsPTP | `srcvers >= 366 && 41` | PTP timing (multi-room) |
| 42 | SupportsScreenMultiCodec | | Multi-codec screen mirroring |
| 43 | SupportsSystemPairing | | System pairing (implies bit 48) |
| 44 | IsAPValeriaScreenSender | | Valeria screen sender |
| 45 | — | | Unknown |
| 46 | SupportsHKPairingAndAccessControl | | HomeKit pairing and access control |
| 47 | — | | Unknown |
| 48 | SupportsTransientPairing | `38 \|\| 46 \|\| 43 \|\| 48` | Transient pairing (implied by 43) |
| 49 | SupportsAirPlayVideoV2 | | AirPlay video v2 |
| 50 | MetadataFeatures_4 | | NowPlaying info via bplist (overrides bit 17) |
| 51 | SupportsUnifiedPairSetupAndMFi | | Unified pair-setup with MFi (Auth type 8) |
| 52 | SupportsSetPeersExtendedMessage | | Extended SETPEERS message |
| 54 | SupportsAPSync | | AP sync support |
| 55 | SupportsWoL | `55 \|\| 56` | Wake-on-LAN |
| 56 | SupportsWoL | `55 \|\| 56` | Wake-on-LAN (alternate) |
| 58 | SupportsHangdogRemoteControl | Device-dependent | Remote control support |
| 59 | SupportsAudioStreamConnectionSetup | `59 && !disable` | Audio stream connection setup |
| 60 | SupportsAudioMediaDataControl | `59 && 60 && !disable` | Media data control |
| 61 | SupportsRFC2198Redundancy | | RFC 2198 redundancy |

### 2.2.1 Derived Feature Checks

| Property | Condition | Description |
|----------|-----------|-------------|
| AudioFormats | `supportedFormats \|\| (18 \| 19 \| 20 \| 21)` | Audio format support |
| SupportsAirPlayVideo | `0 \|\| 49` | Any video support |
| SupportsExtendedWHA | `srcvers >= 366 && (41 \|\| forceAirPlay2NTP) && 40` | Extended WHA |
| ThirdPartySpeaker | `26 \|\| 51` | Third-party speaker |
| ThirdPartyTV | `(26 \|\| 51) && (0 \|\| 49)` | Third-party TV |
| SupportsTransientPairing | `48 \|\| 43` | Transient pairing support |
| SupportsKeepAlive | `srcvers >= 0.74.25` | Keep-alive support |
| SupportsUnifiedPairVerifyAndMFi | `51 && srcvers >= 377` | Unified pair-verify with MFi |
| SupportsInitialVolume | `!32 && srcvers >= 120.2` | Initial volume setting |
| SupportsMuteCommand | `srcvers >= 370.35` | Mute command support |

### 2.2.2 Minimal Feature Set for Multi-room

A widely referenced minimal set for multi-room includes:
- bit 9: SupportsAirPlayAudio
- bit 11: AudioRedundant
- bit 30: HasUnifiedAdvertiserInfo
- bit 40: SupportsBufferedAudio
- bit 41: SupportsPTP
- bit 51: SupportsUnifiedPairSetupAndMFi

This corresponds to `0x8030040000a00` (i.e. `features=0x40000a00,0x80300`).

### 2.2.3 Known Device Feature Values

Feature signatures observed from real devices:

| Device | Model | Features |
|--------|-------|----------|
| Apple TV 4K | `AppleTV5,3` | `0x5A7FDFD5,0x3C155FDE` |
| HomePod | `AudioAccessory1,1` | `0x4A7FCA00,0x3C356BD0` |
| AirPort Express 2 | `AirPort10,115` | `0x445D0A00,0x1C340` |
| Sonos Symfonisk | — | `0x445F8A00,0x1C340` |
| Roku (3810X) | — | `0x7F8AD0,0x10BCF46` |
| Samsung TV (UNU7090) | — | `0x7F8AD0,0x38BCB46` |

**HomePod detection:** If `model` starts with `AudioAccessory`, treat as HomePod-class device (uses HomeKit identifiers `hkid`, `hgid`, `hmid`).

### 2.3 Bit Placement in `0xLOWER,0xUPPER`

When expressing bit constants:
- Bits 0–31 affect the LOWER word.
- Bits 32–63 affect the UPPER word.

Examples (word form):
- bit 40 → `0x00000000,0x00000100`
- bit 41 → `0x00000000,0x00000200`
- bit 51 → `0x00000000,0x00080000`

### 2.4 Version Gates (`srcvers`)

Some capability checks in the ecosystem gate features on `srcvers` in addition to bits. A sender SHOULD primarily trust `features`, but MAY use `srcvers` to resolve ambiguous cases (e.g., if bits are inconsistent across models/firmware).

Key version gates:
- `srcvers >= 354.54.6` — SupportsBufferedAudio
- `srcvers >= 366` — SupportsPTP
- `srcvers >= 377` — SupportsUnifiedPairVerifyAndMFi
- `srcvers >= 120.2` — SupportsInitialVolume
- `srcvers >= 370.35` — SupportsMuteCommand

### 2.5 Status Flags (`flags` / `sf`)

The `flags` field (also `sf` in `_raop._tcp`) is a bitmask indicating device state:

| Bit | Name | Description |
|-----|------|-------------|
| 0 | ProblemDetected | Problem has been detected (CarPlay, rarely seen) |
| 1 | NotConfigured | Device is not configured (CarPlay, rarely seen) |
| 2 | AudioCableAttached | Audio cable is attached (seen on AppleTV, HomePod, AirPort Express) |
| 3 | PINRequired | PIN/password required for pairing |
| 4 | — | Unknown |
| 5 | — | Unknown |
| 6 | SupportsAirPlayFromCloud | Supports cloud playback |
| 7 | PasswordRequired | Password required for connection |
| 8 | — | Unknown |
| 9 | OneTimePairingRequired | One-time pairing required |
| 10 | DeviceWasSetupForHKAccessControl | Device configured for HomeKit access control |
| 11 | DeviceSupportsRelay | Relayable; iOS connects to get currently playing track |
| 12 | SilentPrimary | Silent primary mode |
| 13 | TightSyncIsGroupLeader | Tight sync group leader |
| 14 | TightSyncBuddyNotReachable | Tight sync buddy not reachable |
| 15 | IsAppleMusicSubscriber | Apple Music subscriber (shows as "music" in logs) |
| 16 | CloudLibraryIsOn | Cloud library enabled (shows as "iCML" in logs) |
| 17 | ReceiverSessionIsActive | AirPlay receiving active (shows as "airplay-receiving" in logs) |

**State change examples:**

Device not playing:
```
flags=0x10644
gid=712F0759-5D44-41E7-AB67-FAB0AD39E165
igl=1
gcgl=1
```

Receiving AirPlay audio/video:
```
flags=0x30e44
gid=19F5D4B2-8A06-4792-923E-8AFA83913238
igl=0
gcgl=0
pgid=19F5D4B2-8A06-4792-923E-8AFA83913238
pgcgl=0
```

---

## 3. Pairing, Authentication, and Control-Channel Encryption

### 3.1 Overview

AirPlay deployments may involve multiple mechanisms:

- HKP pairing (`/pair-setup`, `/pair-verify`) for authenticated/encrypted control connections.
- Optional MFi authentication (`/auth-setup`) on devices requiring licensed accessories.
- Optional FairPlay-related steps (`/fp-setup`) on some receivers/senders.

Senders MUST implement HKP if targeting AirPlay 2 audio receivers that require it.

**Legal note:** Some authentication mechanisms may be subject to licensing. This RFC does not describe methods for bypassing licensing requirements.

### 3.2 HKP: Pair-Setup (`POST /pair-setup`)

Pair-Setup is a TLV8 (Type/Length/Value) exchange using SRP-6a with SHA-512 and Ed25519 identity material.

#### 3.2.0 SRP-6a Parameters (HomeKit)

HomeKit pairing uses SRP-6a with specific parameters:

| Parameter | Value |
|-----------|-------|
| Group | 3072-bit (RFC 5054 Appendix A, **not** 2048-bit) |
| Hash | SHA-512 |
| Salt | 16 bytes (sent by receiver in M2) |
| Proof | 64 bytes (SHA-512 output) |
| Session key | 64 bytes (derived from shared secret) |
| Username/Identity | Literal string `"Pair-Setup"` |
| Default PIN | `"3939"` (when access control allows) |

**Note:** Legacy "Fruit" mode (Apple TV < tvOS 10.2) uses 2048-bit group with AES-CBC instead of ChaCha20-Poly1305. Modern devices use 3072-bit.

Senders MUST:
- implement TLV8 framing (values may exceed 255 bytes via TLV type repetition),
- implement SRP-6a with **3072-bit group** and **SHA-512**,
- use `"Pair-Setup"` as the SRP username/identity,
- support "code/PIN/password" entry when receiver policy demands it.

**Do not assume a default code.** Some references mention a default of "3939" for certain HKP scenarios, but real devices (notably HomePod) are often governed by Home access-control and/or user-set passwords (see §9).

#### 3.2.1 TLV8 Type Definitions

| Type | Name | Description |
|------|------|-------------|
| 0x00 | kTLVType_Method | Pairing method (0x00=PairSetup, 0x01=PairSetupWithAuth, 0x02=PairVerify) |
| 0x01 | kTLVType_Identifier | Pairing identifier (device ID) |
| 0x02 | kTLVType_Salt | SRP salt (16 bytes) |
| 0x03 | kTLVType_PublicKey | SRP public key or Ed25519/Curve25519 public key |
| 0x04 | kTLVType_Proof | SRP proof (64 bytes) |
| 0x05 | kTLVType_EncryptedData | Encrypted TLV data with auth tag |
| 0x06 | kTLVType_State | Pairing state (M1=0x01, M2=0x02, ..., M6=0x06) |
| 0x07 | kTLVType_Error | Error code |
| 0x09 | kTLVType_RetryDelay | Retry delay in seconds |
| 0x0A | kTLVType_Certificate | MFi certificate |
| 0x0B | kTLVType_Signature | Ed25519 signature |
| 0x0C | kTLVType_Permissions | Pairing permissions |
| 0x0D | kTLVType_FragmentData | Fragment data |
| 0x0E | kTLVType_FragmentLast | Last fragment flag |
| 0x10 | kTLVType_Flags | Pairing flags (0x00=Transient, 0x01=Split) |
| 0xFF | kTLVType_Separator | Separator between TLV items of same type |

#### 3.2.2 TLV8 Error Codes

| Code | Name | Description |
|------|------|-------------|
| 0x01 | kTLVError_Unknown | Unknown error |
| 0x02 | kTLVError_Authentication | Authentication failed |
| 0x03 | kTLVError_Backoff | Too many attempts, retry later |
| 0x04 | kTLVError_MaxPeers | Max peers reached |
| 0x05 | kTLVError_MaxTries | Max authentication attempts |
| 0x06 | kTLVError_Unavailable | Resource unavailable |
| 0x07 | kTLVError_Busy | Device busy with another pairing |

#### 3.2.3 X-Apple-HKP Header Values

The `X-Apple-HKP` header indicates the pairing mode:

| Value | Mode | Description |
|-------|------|-------------|
| 3 | Normal HomeKit | PIN-based persistent pairing (Apple TV) |
| 4 | Transient HomeKit | Transient pairing, no PIN required (HomePod, AirPort Express) |

#### 3.2.4 Normal Pair-Setup Flow (M1–M6)

For persistent pairing (Apple TV with PIN):

**M1 (Client → Server):**
```
TLV: kTLVType_Method = 0x00 (PairSetup) or 0x01 (PairSetupWithAuth)
TLV: kTLVType_State = 0x01
```

**M2 (Server → Client):**
```
TLV: kTLVType_State = 0x02
TLV: kTLVType_Salt = <16 bytes>
TLV: kTLVType_PublicKey = <384 bytes SRP-B>
```

**M3 (Client → Server):**
```
TLV: kTLVType_State = 0x03
TLV: kTLVType_PublicKey = <384 bytes SRP-A>
TLV: kTLVType_Proof = <64 bytes M1>
```

**M4 (Server → Client):**
```
TLV: kTLVType_State = 0x04
TLV: kTLVType_Proof = <64 bytes M2>
[Optional for MFi: TLV: kTLVType_EncryptedData = <encrypted MFi data>]
```

**M5 (Client → Server):**
```
TLV: kTLVType_State = 0x05
TLV: kTLVType_EncryptedData = <encrypted: identifier + Ed25519 public key + signature>
```

**M6 (Server → Client):**
```
TLV: kTLVType_State = 0x06
TLV: kTLVType_EncryptedData = <encrypted: identifier + Ed25519 public key + signature>
```

#### 3.2.5 HomeKit Transient Pairing Flow (M1–M4)

For transient pairing (HomePod, AirPort Express with `X-Apple-HKP: 4`):

**Key differences from normal pairing:**
1. M1 includes `kTLVType_Flags = 0x00` (Transient flag)
2. Flow completes at M4 (no M5/M6 Ed25519 exchange)
3. Control-channel keys are derived directly from SRP shared secret
4. **Pair-verify is NOT required** (and may be rejected)

**M1 (Client → Server):**
```
TLV: kTLVType_Method = 0x00
TLV: kTLVType_State = 0x01
TLV: kTLVType_Flags = 0x00 (Transient)
```

**M2–M4:** Same as normal flow

After M4 completes successfully, derive control-channel encryption keys directly from the SRP shared secret using HKDF (see §3.4.1).

### 3.3 HKP: Pair-Verify (`POST /pair-verify`)

Pair-Verify is a TLV8 exchange (M1–M4) using Curve25519 (ECDH) and Ed25519 signatures to bind identities.

**Important:** For HomeKit Transient devices, transient SRP pairing is sufficient to derive control keys; pair-verify is typically used only for **persistent** pair-setup flows.

#### 3.3.1 Pair-Verify Flow (M1–M4)

**M1 (Client → Server):**
```
TLV: kTLVType_State = 0x01
TLV: kTLVType_PublicKey = <32 bytes Curve25519 public key>
```

**M2 (Server → Client):**
```
TLV: kTLVType_State = 0x02
TLV: kTLVType_PublicKey = <32 bytes server Curve25519 public key>
TLV: kTLVType_EncryptedData = <encrypted: identifier + signature>
```

**M3 (Client → Server):**
```
TLV: kTLVType_State = 0x03
TLV: kTLVType_EncryptedData = <encrypted: identifier + signature>
```

**M4 (Server → Client):**
```
TLV: kTLVType_State = 0x04
```

### 3.4 HKDF Key Derivation Parameters

All key derivation uses HKDF-SHA-512 with specific salt and info strings.

#### 3.4.1 Control-Channel Encryption Keys

| Direction | Salt | Info | Output |
|-----------|------|------|--------|
| Client → Server | `"Control-Salt"` | `"Control-Write-Encryption-Key"` | 32 bytes |
| Server → Client | `"Control-Salt"` | `"Control-Read-Encryption-Key"` | 32 bytes |

**Input Key:**
- For transient pairing: SRP shared secret (64 bytes)
- For normal pairing after pair-verify: Curve25519 shared secret

#### 3.4.2 Pair-Setup Encryption Keys (M5/M6)

| Purpose | Salt | Info | Output |
|---------|------|------|--------|
| M5/M6 encryption | `"Pair-Setup-Encrypt-Salt"` | `"Pair-Setup-Encrypt-Info"` | 32 bytes |
| Controller sign | `"Pair-Setup-Controller-Sign-Salt"` | `"Pair-Setup-Controller-Sign-Info"` | 32 bytes |
| Accessory sign | `"Pair-Setup-Accessory-Sign-Salt"` | `"Pair-Setup-Accessory-Sign-Info"` | 32 bytes |

**Input Key:** SRP session key (64 bytes)

#### 3.4.3 Pair-Verify Encryption Keys (M2/M3)

| Purpose | Salt | Info | Output |
|---------|------|------|--------|
| M2/M3 encryption | `"Pair-Verify-Encrypt-Salt"` | `"Pair-Verify-Encrypt-Info"` | 32 bytes |

**Input Key:** Curve25519 shared secret

#### 3.4.4 MFi Authentication Keys

| Purpose | Salt | Info | Output |
|---------|------|------|--------|
| MFi challenge | `"MFi-Pair-Setup-Salt"` | `"MFi-Pair-Setup-Info"` | 32 bytes |

### 3.5 Post-Pairing Control Framing (Encrypted)

After pairing succeeds, control traffic on the existing TCP connection switches to encrypted framing:

```
uint16_le length N || ciphertext (N bytes) || tag (16 bytes)
```

Encryption is ChaCha20-Poly1305; each direction uses its own key and monotonically increasing nonce/counter.

**Nonce construction:** The nonce is 96 bits (12 bytes):
- First 4 bytes: `0x00000000`
- Last 8 bytes: 64-bit counter (little-endian), starting at 0

Senders MUST:
- maintain independent counters per direction,
- ensure nonce uniqueness per key (no reuse),
- fail closed on authentication/tag failures.

### 3.6 Ed25519 Signature Message Format

For M5/M6 signature verification:

```
iOSDeviceX = HKDF(SRP_session_key, "Pair-Setup-Controller-Sign-Salt", "Pair-Setup-Controller-Sign-Info", 32)
Message = iOSDeviceX || client_device_id || client_ed25519_public_key
Signature = Ed25519_Sign(client_ed25519_private_key, Message)
```

Total message length: 32 + device_id_length + 32 = typically 100 bytes

### 3.7 MFi Authentication (`POST /auth-setup`) (Optional / Licensed)

If receiver policy requires MFi authentication (indicated by `HasUnifiedAdvertiserInfo` feature bit 26), it can be raised either via `/auth-setup` challenge or included in pairing via `SupportsUnifiedPairSetupAndMFi` (bit 51).

**Important:** Even though this is server authentication (clients verify MFi authenticity), AirPlay 2 devices require this request to be made. The server will deny further requests if `/auth-setup` is skipped.

#### 3.7.1 Challenge Process

1. Client generates Curve25519 key pair
2. Client sends public key to server
3. Server appends its public key with client's (message to sign)
4. Server gets signature from Apple authentication IC (RSA-1024, SHA-1)
5. Signature is encrypted with AES-128-CTR:
   - Key = first 16 bytes of `SHA1("AES-KEY" || Curve25519_shared_secret)`
   - IV = first 16 bytes of `SHA1("AES-IV" || Curve25519_shared_secret)`
6. Server responds with its public key, encrypted signature, and certificate

#### 3.7.2 Request Format

```
<1:Encryption Type>
<32:Client's Curve25519 public key>
```

| Value | Type |
|-------|------|
| 0x00 | Invalid |
| 0x01 | Unencrypted |
| 0x10 | MFi-SAP-encrypted AES key |

#### 3.7.3 Response Format

```
<32:Server's Curve25519 public key>
<4:Certificate length (int32be)>
<n:PKCS#7 DER encoded MFiCertificate>
<4:Signature length (int32be)>
<n:Signature>
```

Senders SHOULD implement a feature-gated branch:
- If receiver advertises MFi requirement (device/feature dependent), attempt `/auth-setup`.
- If not supported/possible, present a clear error describing "receiver requires licensed authentication."

### 3.8 FairPlay Setup (`POST /fp-setup`) (Optional)

Some device pairings involve `/fp-setup`. Behavior is proprietary and can vary. If a receiver refuses SETUP/RECORD without it, sender interoperability may require implementing the observed negotiation for that receiver family.

---

## 4. Control Protocol (RTSP-like)

### 4.1 Connection

The sender opens a TCP connection to the `_airplay._tcp` endpoint from SRV.

### 4.2 Baseline Request Flow (Typical)

A sender typically performs:

1. `GET /info` (capabilities)
2. Pairing/authentication (`/pair-setup`, `/pair-verify`, optionally `/auth-setup` and/or `/fp-setup`)
3. `SETUP` phase 1 (event + timing + crypto metadata)
4. `SETUP` phase 2 (audio stream definitions)
5. `RECORD` (start)
6. Periodic keepalive (commonly `POST /feedback`)
7. `SET_PARAMETER` for volume/metadata
8. `FLUSH` for discontinuities
9. `TEARDOWN` to end

### 4.3 Headers (Observed)

Header requirements differ across receiver families. Senders SHOULD include:

- `CSeq: <int>` (monotonic per connection)
- `User-Agent: AirPlay/<version>`
- `X-Apple-ProtocolVersion: 1`
- `DACP-ID` and `Active-Remote` when integrating remote control behaviors
- `X-Apple-Device-ID`, `X-Apple-Session-ID` when required by specific receivers
- `X-Apple-ET: 32` (encryption type, for fp-setup)
- `X-Apple-HKP: 3` or `X-Apple-HKP: 4` for pairing requests

Senders MUST tolerate 4xx responses and MAY retry with additional headers if receiver appears strict.

---

## 5. SETUP Negotiation (Two-Phase Binary Plist)

### 5.1 Content Type

AirPlay 2 audio SETUP frequently uses `application/x-apple-binary-plist`. Senders MUST be able to parse and generate binary plists.

### 5.2 Phase 1: Event + Timing + Encryption Parameters

Phase 1 typically configures:
- sender identity
- timing protocol selection: `PTP` vs NTP-like
- timing peer info (addresses, IDs)
- encryption parameters (keys/IVs or derived keys, depending on receiver)

#### 5.2.1 Phase 1 Request Fields (Observed)

```
Root dict:
  deviceID: string       # MAC address format, e.g., "AA:BB:CC:DD:EE:FF"
  sessionUUID: string    # UUID for this session
  timingPort: uint       # Sender's timing port for NTP responses
  timingProtocol: string # "NTP" or "PTP"
  eiv: data              # Encryption IV (16 bytes, if using AES)
  ekey: data             # Encryption key (16 bytes, if using AES)
  et: uint               # Encryption type (32 = ChaCha20-Poly1305)
```

#### 5.2.2 Phase 1 Response Fields (Observed)

```
Root dict:
  eventPort: uint        # Receiver's event/feedback port
  timingPort: uint       # Receiver's timing port (may be 0 if unused)
```

**PTP note:** In PTP mode, the RTSP "time channel" is not used; timing is handled via PTP on UDP 319/320 and the time channel stays down.

### 5.3 Phase 2: Stream Definitions

Phase 2 defines one or more audio streams.

#### 5.3.1 Phase 2 Request Fields (Observed)

```
Root dict:
  streams: array         # Array of stream definition dicts
```

Each stream dict contains:

| Field | Type | Description |
|-------|------|-------------|
| `type` | uint | RTP payload type: 96 (realtime) or 103 (buffered) |
| `ct` | uint | Compression type (see below) |
| `audioFormat` | uint | Format descriptor (e.g., 0x40000 = ALAC/44100/16/2) |
| `audioMode` | string | Mode string, typically "default" |
| `sr` | uint | Sample rate (44100, 48000, etc.) |
| `spf` | uint | Samples per frame/packet (typically 352 for ALAC, 1024 for AAC) |
| `latencyMin` | uint | Minimum latency in samples (e.g., 11025 = ~250ms at 44.1kHz) |
| `latencyMax` | uint | Maximum latency in samples (e.g., 88200 = ~2s at 44.1kHz) |
| `shk` | data | Shared key for RTP encryption (32 or 64 bytes) |
| `isMedia` | bool | Media stream flag |
| `controlPort` | uint | Sender's control/RTCP port |
| `supportsDynamicStreamID` | bool | Dynamic stream ID support |
| `streamConnectionID` | uint | Session/connection identifier |

**Compression type (`ct`) values:**

| Value | Codec |
|-------|-------|
| 1 | LPCM (uncompressed) |
| 2 | ALAC |
| 3 | AAC |
| 4 | AAC-ELD |
| 32 | Opus |

**Audio format (`audioFormat`) bit values:**

The `audioFormat` field is a bitmask indicating the audio format. Common values:

| Bit | Value | Format | Notes |
|-----|-------|--------|-------|
| 18 | 0x40000 | ALAC/44100/16/2 | Default, widely supported |
| 19 | 0x80000 | ALAC/44100/24/2 | 24-bit ALAC |
| 20 | 0x100000 | ALAC/48000/16/2 | 48kHz ALAC |
| 21 | 0x200000 | ALAC/48000/24/2 | 48kHz 24-bit ALAC |
| 22 | 0x400000 | AAC-LC/44100/2 | Buffered audio |
| 23 | 0x800000 | AAC-LC/48000/2 | 48kHz AAC |
| 24 | 0x1000000 | AAC-ELD/44100/2 | Low-delay AAC |
| 25 | 0x2000000 | AAC-ELD/48000/2 | 48kHz low-delay AAC |

**Typical values:**
- Realtime ALAC: `audioFormat=0x40000`, `ct=2`, `spf=352`, `type=96`
- Buffered AAC: `audioFormat=0x400000`, `ct=3`, `spf=1024`, `type=103`

#### 5.3.2 Phase 2 Response Fields (Observed)

For each stream in the response:

```
streams[]:
  dataPort: uint         # Receiver's RTP audio data port
  controlPort: uint      # Receiver's RTP control/RTCP port
  eventPort: uint        # Receiver's event port (may duplicate Phase 1)
  timingPort: uint       # Receiver's timing port (may be 0)
```

**Observed log format:** `"Negotiated UDP streaming session; ports d=%u c=%u t=%u e=%u"` (data, control, timing, event)

#### 5.3.3 Stream Type Selection

- `type: 96` — realtime audio (often ALAC)
- `type: 103` — buffered audio (often AAC)

Senders SHOULD:
- prefer buffered audio when receiver supports it (observed: feature bit 40),
- otherwise fall back to realtime.

---

## 6. Audio Transport (RTP)

### 6.1 Ports

Receivers return negotiated ports in SETUP responses (dataPort/controlPort/eventPort, etc.). Senders MUST use negotiated ports, not defaults.

### 6.2 RTP Payload Types

| Payload Type | Port | Description |
|--------------|------|-------------|
| 82 | timing_port | Timing request |
| 83 | timing_port | Timing reply |
| 84 | control_port | Time sync |
| 85 | control_port | Retransmit request |
| 86 | control_port | Retransmit reply |
| 96 | server_port | Audio data (realtime) |
| 103 | server_port | Audio data (buffered) |

### 6.3 RTP Payload Protection (Observed AirPlay 2) ✓ Confirmed Working

AirPlay 2 audio RTP packets use ChaCha20-Poly1305 encryption with a 24-byte trailer.

#### 6.3.1 Packet Structure

```
[RTP Header (12 bytes)][Encrypted Payload][Auth Tag (16 bytes)][Nonce (8 bytes)]
```

**IMPORTANT:** The trailer order is **Tag first (16 bytes), then Nonce (8 bytes)** (total 24 bytes).

- Tag is located at `packet_length - 24` through `packet_length - 8`
- Nonce is located at `packet_length - 8` through `packet_length`

This ordering has been confirmed working with real AirPlay 2 receivers.

#### 6.3.2 Encryption Details

| Component | Details |
|-----------|---------|
| Algorithm | ChaCha20-Poly1305 AEAD |
| Key | `shk` from SETUP Phase 2 (32 bytes) |
| Nonce | 12 bytes internally; 8 bytes transmitted (see below) |
| AAD | RTP timestamp (4 bytes) ∥ SSRC (4 bytes), big-endian |
| Tag | 16 bytes (Poly1305 MAC) |

#### 6.3.3 Nonce Construction

The 12-byte ChaCha20 nonce is constructed from the RTP sequence number:

```
nonce[0..3]  = 0x00000000                    # First 4 bytes are zero
nonce[4..5]  = RTP sequence number (u16 LE)  # Host/little-endian byte order
nonce[6..11] = 0x000000000000                # Remaining 6 bytes are zero
```

**Transmitted format:** Only `nonce[4..11]` (8 bytes) is transmitted in the packet trailer.

**Sequence-based nonce:** The nonce includes the RTP sequence number at offset 4 (in little-endian byte order). This matches the owntone implementation: `memcpy(nonce + 4, &pkt->seqnum, sizeof(pkt->seqnum))` where `seqnum` is `uint16_t` in host byte order.

**Rationale:** Using a sequence-based nonce ensures:
1. Unique nonces for each packet (as long as sequences don't repeat)
2. Deterministic encryption - retransmissions of the same packet produce identical ciphertext
3. Receivers can verify retransmitted packets match the original

**Wire format example:**

For RTP sequence number `0x002A` (42 in decimal):
```
12-byte internal nonce: [00 00 00 00][2A 00][00 00 00 00 00 00]
                         └─ zeros ─┘ └seq┘ └──── zeros ────┘
8-byte transmitted:                 [2A 00 00 00 00 00 00 00]
```

The sequence number is placed at nonce[4..5] in **little-endian** byte order, matching C struct layout on little-endian systems (x86, ARM).

#### 6.3.4 AAD (Additional Authenticated Data)

The AAD is 8 bytes taken from the RTP header:

```
AAD = rtp_header[4..7] || rtp_header[8..11]
    = timestamp (4 bytes, big-endian) || SSRC (4 bytes, big-endian)
```

Senders MUST:
- use the `shk` key from SETUP for encryption,
- construct the 12-byte nonce with 4 leading zero bytes and sequence number at offset 4,
- include timestamp and SSRC as AAD,
- append the 16-byte Poly1305 tag followed by the 8-byte nonce to the ciphertext,
- verify tags on incoming retransmit replies where applicable,
- support retransmission requests if receiver expects it.

#### 6.3.5 Complete Packet Example

A complete encrypted audio packet on the wire:

```
Offset  Content                         Size    Description
------  -------                         ----    -----------
0       80 60 00 2A 00 00 AC 44        12      RTP header (V=2, PT=96, seq=42, ts=44100, SSRC omitted)
        XX XX XX XX...
12      [encrypted audio payload]       N       ChaCha20-encrypted ALAC/AAC frame
12+N    [16-byte Poly1305 tag]          16      Authentication tag (offset N-24 from end)
12+N+16 [8-byte nonce]                  8       Nonce: sequence number + zeros (offset N-8 from end)
```

**Encryption process:**
1. Construct 12-byte nonce from sequence number
2. Build AAD from RTP timestamp and SSRC (8 bytes, both big-endian)
3. Encrypt audio payload with ChaCha20-Poly1305 (key=`shk`, nonce, AAD)
4. Serialize: RTP header ∥ ciphertext ∥ tag (16) ∥ nonce[4..11] (8)

#### 6.3.6 RTP Marker Bit

The RTP marker bit (bit 7 of byte 1) MUST be set on the **first audio packet** sent after a device joins the stream. This signals to the receiver that this is the start of a new playback session.

```
byte 1 = (marker << 7) | payload_type
```

**Observed behavior (owntone):** The marker bit is set to 1 for the first audio packet, then 0 for all subsequent packets. Some receivers may not play audio correctly without this initial marker.

### 6.4 Sync Packets (PT=84)

Sync packets correlate RTP timestamps to NTP time for clock synchronization. They are sent once per second to the control port.

**Packet structure:**

| Bytes | Description |
|-------|-------------|
| 8 | RTP header without SSRC |
| 8 | Current NTP time |
| 4 | RTP timestamp for the next audio packet |

- Payload type: 84
- Marker bit: always set
- Extension bit: set on first packet after RECORD or FLUSH

### 6.5 Retransmit Packets (PT=85/86)

AirTunes supports resending lost audio packets.

**Retransmit request (PT=85):**

| Bytes | Description |
|-------|-------------|
| 8 | RTP header without SSRC |
| 2 | Sequence number for first lost packet |
| 2 | Number of lost packets |

- Marker bit: always set

**Retransmit reply (PT=86):**
Contains a full audio RTP packet after the sequence number.

### 6.6 Two Observed Stream Families (Practical)

- **Realtime (PT=96)**: ALAC, "classic-like" latency (~2s in many stacks).
- **Buffered (PT=103)**: AAC, lower latency (~0.5s typical).

---

## 7. Timing and Synchronization

### 7.1 NTP-style Timing (Single Room)

For single-room playback, AirPlay uses an NTP-like timing protocol on a negotiated UDP port (from SETUP Phase 1).

#### 7.1.1 NTP Epoch

AirPlay NTP timestamps use the NTP epoch (January 1, 1900), not Unix epoch (January 1, 1970).

```
NTP_EPOCH_DELTA = 0x83AA7E80  # 2208988800 seconds (1970 - 1900)
```

To convert Unix time to NTP time: `ntp_seconds = unix_seconds + 0x83AA7E80`

#### 7.1.2 NTP Timestamp Format

NTP timestamps are 64-bit values:
- Upper 32 bits: seconds since NTP epoch
- Lower 32 bits: fractional seconds (1/2^32 second resolution)

#### 7.1.3 Timing Exchange

1. Receiver sends timing request to sender's `timingPort`
2. Sender records receive timestamp (`t2`)
3. Sender records transmit timestamp (`t3`)
4. Sender sends timing reply with both timestamps

The receiver uses `t1` (its send time), `t2`, `t3`, and `t4` (its receive time) to calculate clock offset and round-trip delay.

### 7.2 PTP (Multi-room)

AirPlay 2 multi-room generally relies on PTP (IEEE 1588), UDP ports 319/320. Senders MUST implement PTP participation or delegate to a PTP stack if aiming for multi-room.

#### 7.2.1 PTP Offset Calculation

```
offset = ((t2 - t1) + (t3 - t4)) / 2
delay  = ((t2 - t1) - (t3 - t4)) / 2
```

Where:
- `t1` = master send time (Sync message)
- `t2` = slave receive time (Sync arrival)
- `t3` = slave send time (Delay_Req)
- `t4` = master receive time (Delay_Resp)

### 7.3 Implementation Notes

Some receiver implementations (e.g., Shairport Sync) use a companion daemon (NQPTP) and may require exclusive access to ports 319/320; this impacts test environments.

---

## 8. Multi-room Peer Coordination (High Level)

Multi-room can involve distributing a peer list ("SETPEERS"-style command) and aligning playback to a shared clock.

A sender implementing multi-room SHOULD:
- manage group identifiers (`gid`) from discovery,
- keep peer membership updated,
- coordinate start times against PTP time.

---

## 9. HomePod: Pairing, Access Control, and "It Works on iPhone but Not My Sender"

HomePod is commonly blocked by **Home app access-control**, not by "missing protocol steps".

### 9.1 Speaker Access Settings (User-facing, but Protocol-critical)

In the Home app:
Home Settings → **Speakers & TV** / "Allow Speaker & TV Access":
- Everyone
- Anyone on the Same Network
- Only People Sharing This Home

Optional: **Require Password**.

These settings apply across multiple HomePods in the home.

### 9.2 Sender Requirements for HomePod Compatibility

- If access is "Only People Sharing This Home", a custom sender without Home membership credentials may be rejected even if pairing is implemented.
- If "Require Password" is enabled, sender SHOULD prompt user for password and persist it securely.
- Sender SHOULD expose diagnostics: "HomePod access policy blocks connection" vs "pairing/auth failed" vs "SETUP rejected".

### 9.3 Recommended HomePod Pairing Flow

For HomeKit Transient devices, the **recommended path** is:

1. Connect to receiver's AirPlay port
2. Send `POST /pair-setup` with `X-Apple-HKP: 4` header
3. Complete SRP transient pair-setup (M1–M4) with PIN "3939"
4. Derive control-channel keys from SRP shared secret using HKDF
5. Switch to encrypted RTSP (skip pair-verify)
6. Proceed with SETUP and RECORD

---

## 10. Device-Specific Quirks

Some devices require non-standard handling. Senders SHOULD detect these devices by model string and apply workarounds.

### 10.1 Devices Requiring `/auth-setup`

The following devices reject SETUP without a prior `/auth-setup` exchange:

| Device | Detection |
|--------|-----------|
| Sonos Beam | Model contains "Sonos" |
| AirPort Express (firmware 7.8+) | Model `AirPort10,115` |

For these devices, send `POST /auth-setup` with minimal payload before SETUP. The auth-setup may succeed with an "encryption not required" response.

### 10.2 Timing Port Anomalies

| Device | Behavior | Workaround |
|--------|----------|------------|
| Apple TV 4 | Returns `timingPort=0` in SETUP response | Ignore; use sender's configured timing port |

### 10.3 Volume Ordering (Sonos)

Some Sonos devices do not register volume changes unless the volume `SET_PARAMETER` is sent last in a sequence of parameter updates. Senders SHOULD reorder volume updates to be the final parameter set.

---

## 11. Interoperability Guidance

### 11.1 Conservative Decision Tree

1. Prefer `_airplay._tcp` if present; fall back to `_raop._tcp` for legacy.
2. Parse `features`:
   - If buffered audio supported (observed bit 40), prefer PT=103.
   - Else use realtime PT=96.
3. If multi-room required:
   - Require PTP support (observed bit 41) and implement PTP participation.
4. Determine pairing mode:
   - If `SupportsTransientPairing` (bit 43 || bit 48): use transient pair-setup (`X-Apple-HKP: 4`)
   - Else: use normal pair-setup + pair-verify (`X-Apple-HKP: 3`)
5. Perform HKP pairing; then SETUP phase 1/2; then RECORD.
6. Keepalive with `/feedback` if receiver expects it.

### 11.2 Reference Implementations / Cross-checking

Open-source projects often used for behavior comparison:
- openairplay/ap2-sender (sender prototype)
- openairplay/airplay2-receiver (receiver, Python)
- Shairport Sync (receiver) + NQPTP notes
- pyatv (client library; limited AirPlay/RAOP functionality)
- OwnTone (full-featured media server with AirPlay 2 output)
- pair_ap (HomeKit pairing library, C)

---

## 12. Security Considerations

- Never reuse a ChaCha20-Poly1305 nonce with the same key (control or RTP).
- Treat pairing secrets and long-term identifiers as sensitive; store securely.
- Prefer explicit failure modes and logging; never silently downgrade to insecure modes.
- Validate all TLV8 error codes and handle authentication failures gracefully.

---

## 13. References (Public)

### Reverse Engineering Documentation
- Emanuele Cozzi — AirPlay 2 Internals (Discovery, Features, RTSP, RTP):
  - https://emanuelecozzi.net/docs/airplay2/discovery/
  - https://emanuelecozzi.net/docs/airplay2/features/
  - https://emanuelecozzi.net/docs/airplay2/rtsp
  - https://emanuelecozzi.net/docs/airplay2/rtp
- openairplay — Unofficial AirPlay Specification (HKP pairing, /auth-setup):
  - https://openairplay.github.io/airplay-spec/pairing/hkp.html
  - https://openairplay.github.io/airplay-spec/audio/rtsp_requests/post_auth_setup.html

### Reference Implementations (Sender)
- OwnTone — Full-featured media server with AirPlay 2 output:
  - https://github.com/owntone/owntone-server
  - Key files: `src/outputs/airplay.c`, `src/outputs/airplay_events.c`
- pair_ap — HomeKit pairing library (C):
  - https://github.com/ejurgensen/pair_ap
  - Implements SRP-6a (3072-bit), Ed25519, Curve25519, ChaCha20-Poly1305
- openairplay/ap2-sender — Python sender prototype:
  - https://github.com/openairplay/ap2-sender

### Reference Implementations (Receiver)
- Shairport Sync — AirPlay 2 receiver with NQPTP timing:
  - https://github.com/mikebrady/shairport-sync/blob/master/AIRPLAY2.md
  - https://github.com/mikebrady/nqptp
- openairplay/airplay2-receiver — Python receiver:
  - https://github.com/openairplay/airplay2-receiver

### HomeKit Protocol References
- Apple HomeKitADK — Official HomeKit Accessory Development Kit:
  - https://github.com/apple/HomeKitADK
- HomeSpan — ESP32 HomeKit library with TLV8 documentation:
  - https://github.com/HomeSpan/HomeSpan/blob/master/docs/TLV8.md

### Other Resources
- Apple Support — HomePod speaker access and password settings:
  - https://support.apple.com/guide/homepod/let-others-play-audio-apdb68d3dec5/homepod
  - https://support.apple.com/en-my/guide/ipod-touch/iphcbaf7e8f3/ios
- pyatv documentation (AirPlay/RAOP functionality overview):
  - https://pyatv.dev/
  - https://pyatv.dev/development/stream/

---

## Appendix A: Changelog from Previous Version

### Critical Fixes (🔴)

1. **RTP Packet Trailer Order Confirmed**
   - **Correct (Tested & Working):** `[Encrypted Payload][Auth Tag (16 bytes)][Nonce (8 bytes)]`
   - Tag at offset N-24, Nonce at offset N-8 (where N = packet length)
   - Confirmed working with HomePod and AirPlay 2 receivers
   - Source: Verified implementation testing + owntone reference implementation

2. **HKDF Key Derivation Parameters Added**
   - Complete HKDF-SHA-512 parameters for all key derivations
   - Control-channel, pair-setup, pair-verify, and MFi keys documented
   - Source: openairplay.github.io/airplay-spec/pairing/hkp.html

3. **Transient Pairing Flow Clarified**
   - Transient mode (X-Apple-HKP: 4) completes at M4
   - Skips both M5/M6 Ed25519 exchange AND pair-verify
   - Keys derived directly from SRP shared secret
   - Source: pair_ap library, openairplay spec

4. **TLV8 Type Definitions Added**
   - Complete type codes: 0x00=Method through 0xFF=Separator
   - Error codes documented
   - Source: Apple HomeKitADK, various implementations

### Important Additions (🟡)

5. **Complete Feature Bits Table**
   - Expanded from 6 bits to 30+ known bits with correct naming
   - Fixed bit 26 (HasUnifiedAdvertiserInfo), bit 30 (RAOP), bit 50 (MetadataFeatures_4)
   - Added implication notes (bit 43 implies bit 48)
   - Sources: emanuelecozzi.net, openairplay.github.io

6. **Status Flags Section Added (§2.5)**
   - Complete `flags`/`sf` bitmask documentation (bits 0-17)
   - State change examples for device status
   - Source: openairplay.github.io/airplay-spec/status_flags.html

7. **RTP Payload Types Table (§6.2)**
   - Added timing (82/83), sync (84), retransmit (85/86) payload types
   - Source: openairplay.github.io/airplay-spec/audio/rtp_streams.html

8. **Sync Packets Documentation (§6.4)**
   - PT=84 packet structure for clock correlation
   - Sent once per second to control port

9. **Retransmit Packets Documentation (§6.5)**
   - PT=85 request and PT=86 reply formats
   - Lost packet recovery mechanism

10. **Enhanced /auth-setup Documentation (§3.7)**
    - Complete challenge/response flow
    - AES-128-CTR encryption details (key/IV derivation)
    - Request/response format specifications
    - Source: openairplay.github.io/airplay-spec/audio/rtsp_requests/post_auth_setup.html

11. **Version Gate Conditions**
    - Specific srcvers requirements for features
    - Source: emanuelecozzi.net

12. **SRP Identity String**
    - Documented as literal string "Pair-Setup"

13. **X-Apple-HKP Header Values**
    - 3 = Normal HomeKit (PIN-based, persistent)
    - 4 = Transient HomeKit (no PIN, session-only)

14. **Additional Discovery TXT Keys**
    - rsf, osvers, gcgl, pgid, tsid, and more
    - Source: emanuelecozzi.net/docs/airplay2/discovery/

15. **Ed25519 Signature Message Format**
    - 100-byte message structure for M5/M6



---

## Test Data Sources

### RFC Test Vectors
- SRP-6a: RFC 5054 Appendix B
- HKDF: RFC 5869 Appendix A
- Curve25519: RFC 7748 Section 6.1
- Ed25519: RFC 8032 Section 7.1
- ChaCha20-Poly1305: RFC 8439 Appendix A