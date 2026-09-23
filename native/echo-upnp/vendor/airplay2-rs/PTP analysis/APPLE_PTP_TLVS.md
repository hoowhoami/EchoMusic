# Apple Proprietary PTP TLVs

## Overview

Apple extends IEEE 1588 PTPv2 / 802.1AS gPTP with proprietary TLV extensions for AirPlay 2 timing synchronization. These are carried in Organization Extension TLVs (type 0x0003) with Apple's OUI `00:0d:93`.

## Discovered Subtypes

### Subtype 0x000001 - Unknown Configuration (Signaling)

**Location**: Signaling messages
**Direction**: Master → Slave
**Length**: 22 bytes (16 byte payload)

#### Structure
```
Offset  Length  Field                    Example Value
------  ------  -----------------------  -------------
0       2       Length/Flags?            0x0004
2       2       Version?                 0x0301
4       9       Reserved (zeros)         0x000000000000000000
13      3       Magic constant           0x206f2f (" o/" ASCII)
```

#### Analysis
- The `0x206f2f` constant appears to be an ASCII emoticon " o/" (shrug)
- May be a version tag or protocol magic number
- The `0x0301` value (769 decimal) might be a protocol version
- First field `0x0004` might indicate payload length or feature flags

### Subtype 0x000004 - Clock Source Identity (Follow_Up)

**Location**: Follow_Up messages
**Direction**: Bidirectional (both Master and Slave)
**Length**: 16 bytes (10 byte payload)

#### Structure
```
Offset  Length  Field                    Example Value
------  ------  -----------------------  -------------
0       8       Clock Identity           0x14147de854980008
8       2       Reserved/Port?           0x0000
```

#### Analysis
- **CONFIRMED**: Contains the source clock identity (8 bytes)
- Matches the `ClockIdentity` field from the PTP header
- Last 2 bytes are always `0x0000` - possibly reserved or port number
- **Purpose**: Identifies the timing source in multi-room/multi-device scenarios
- Critical for clock hierarchy tracking in AirPlay groups

#### Examples from Capture

**Master (192.168.0.103)**:
```
Clock ID: 0x14147de854980008
TLV Payload: 14 14 7d e8 54 98 00 08 00 00
```

**Slave (192.168.0.49)**:
```
Clock ID: 0xfe6b3a00f8400008
TLV Payload: fe 6b 3a 00 f8 40 00 08 00 00
```

### Subtype 0x000005 - Extended Configuration (Signaling)

**Location**: Signaling messages
**Direction**: Master → Slave
**Length**: 32 bytes (26 byte payload)

#### Structure
```
Offset  Length  Field                    Example Value
------  ------  -----------------------  -------------
0       2       Length/Flags?            0x0010
2       2       Version?                 0x0301
4       20      Reserved (zeros)         0x00000000... (20 bytes)
24      3       Magic constant           0x206f2f (" o/" ASCII)
```

#### Analysis
- Extended version of subtype 0x000001
- Same `0x0301` version field
- Same `0x206f2f` magic constant
- Larger reserved space suggests room for future extensions
- May contain negotiation parameters or extended capabilities

## Usage in AirPlay 2

### Initial Handshake (Signaling Messages)

1. **Master sends Announce + Signaling**
   - Standard 802.1AS Message Interval Request TLV
   - Apple subtype 0x000001 TLV (configuration)
   - Apple subtype 0x000005 TLV (extended configuration)

2. **Slave responds with Announce + Signaling**
   - Standard 802.1AS Message Interval Request TLV
   - Apple TLVs (same structure)

### Ongoing Synchronization (Follow_Up Messages)

Every Follow_Up message contains:
1. **Standard 802.1AS Follow_Up Information TLV**
   - Cumulative rate offset
   - GM time base indicator
   - Phase change tracking
   - Frequency change tracking

2. **Apple subtype 0x000004 TLV**
   - Clock source identity
   - Enables receivers to track timing hierarchy

## Implementation Notes

### For Senders (Acting as PTP Slave)

When receiving Follow_Up from receiver (acting as PTP Master):
- Parse Apple subtype 0x000004 TLV
- Verify clock identity matches expected master
- Use for multi-room group coherence

### For Receivers (Acting as PTP Master)

When sending Follow_Up to sender (acting as PTP Slave):
- Include Apple subtype 0x000004 TLV with your clock identity
- Helps sender track which receiver is the timing master

### Multi-Room Considerations

The clock identity TLV (0x000004) is critical for:
- Determining which HomePod is the "conductor" in a stereo pair
- Synchronizing multiple senders across grouped receivers
- Maintaining timing hierarchy in complex setups

## Open Questions

1. **What do the "version" fields (0x0301) represent?**
   - Protocol version?
   - Feature flags?
   - AirPlay version?

2. **What is the significance of the " o/" constant?**
   - Version tag?
   - Magic number for validation?
   - Inside joke from Apple engineers? 🤷

3. **What triggers the use of subtype 0x000001 vs 0x000005?**
   - Both appear in the same Signaling message
   - Different feature sets?
   - Legacy compatibility?

4. **Are there other Apple subtypes we haven't seen?**
   - May appear in different scenarios (errors, failover, etc.)

## Recommendations

### Minimal Implementation
For basic AirPlay 2 compatibility:
- **MUST** include Apple subtype 0x000004 in Follow_Up messages
- **SHOULD** include subtypes 0x000001 and 0x000005 in Signaling
- Use captured values as templates if meaning is unclear

### Research Needed
- Capture PTP traffic with stereo-paired HomePods
- Capture group formation/handoff scenarios
- Test with modified TLV values to determine mandatory vs optional fields


## References

- IEEE 1588-2008: IEEE Standard for a Precision Clock Synchronization Protocol
- IEEE 802.1AS-2011: Timing and Synchronization for Time-Sensitive Applications
- AIRPLAY_2_SPEC.md: Main AirPlay 2 specification
- PTP.md: PTP implementation documentation
- Packet capture: airplay_20260126_231656.pcapng

## Revision History

- 2026-01-27: Initial discovery and documentation from pcap analysis
