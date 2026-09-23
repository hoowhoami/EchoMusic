#!/usr/bin/env python3
"""Parse Apple proprietary TLVs from PTP packets"""

import sys

def parse_tlv(data, offset):
    """Parse a single TLV from hex data"""
    if offset + 4 > len(data):
        return None, offset

    tlv_type = int(data[offset:offset+4], 16)
    tlv_len = int(data[offset+4:offset+8], 16)

    if tlv_type != 0x0003:  # Not organization extension
        return None, offset + 8 + tlv_len * 2

    org_id = data[offset+8:offset+14]
    subtype = data[offset+14:offset+20]
    payload_start = offset + 20
    payload_end = offset + 8 + tlv_len * 2
    payload = data[payload_start:payload_end]

    return {
        'type': tlv_type,
        'length': tlv_len,
        'org_id': org_id,
        'subtype': subtype,
        'payload': payload
    }, payload_end

def parse_ptp_message(hex_data):
    """Parse PTP message and extract TLVs"""
    # PTP v2 header is variable length
    # For signaling, it's 44 bytes (0x2c)
    # For follow_up, it's 44 bytes as well

    msg_type = int(hex_data[0:2], 16) & 0x0f
    msg_len = int(hex_data[4:8], 16)

    # Find where TLVs start (after PTP header)
    if msg_type == 0x0c:  # Signaling
        header_len = 44 * 2  # 44 bytes = 88 hex chars
    elif msg_type == 0x08:  # Follow_Up
        header_len = 44 * 2  # 44 bytes = 88 hex chars
    else:
        header_len = 44 * 2

    tlvs = []
    offset = header_len

    while offset < len(hex_data):
        tlv, offset = parse_tlv(hex_data, offset)
        if tlv and tlv['org_id'] == '000d93':  # Apple OUI
            tlvs.append(tlv)
        elif not tlv:
            break

    return {
        'msg_type': msg_type,
        'msg_len': msg_len,
        'tlvs': tlvs
    }

def format_payload(payload, bytes_per_line=16):
    """Format payload as hex with ASCII"""
    result = []
    for i in range(0, len(payload), bytes_per_line * 2):
        chunk = payload[i:i + bytes_per_line * 2]
        hex_part = ' '.join(chunk[j:j+2] for j in range(0, len(chunk), 2))
        ascii_part = ''.join(
            chr(int(chunk[j:j+2], 16)) if 32 <= int(chunk[j:j+2], 16) < 127 else '.'
            for j in range(0, len(chunk), 2)
        )
        result.append(f"  {hex_part:<48}  {ascii_part}")
    return '\n'.join(result)

# Test data from the capture
test_payloads = {
    'Frame 121 (Signaling from Master)': '1c02006a0000040800000000000000000000000014147de8549800088075000005800000000000000000000000030016000d9300000100040301000000000000000000206f2f00030020000d930000050010030100000000000000000000000000000000000000206f2f',
    'Frame 125 (Signaling from Slave)': '1c02006a000004080000000000000000000000fe6b3a00f84000088006000005800000000000000000000000030016000d9300000100040301000000000000000000206f2f00030020000d930000050010030100000000000000000000000000000000000000206f2f',
    'Frame 131 (Follow_Up from Master)': '18020060000004080000017d54c400000000000014147de8549800088075000102fd00000001f2bd1b9f2a430003001c0080c200000100000000000000000000fffc7f644e816120f23e19d000030010000d9300000414147de8549800080000',
}

msg_type_names = {
    0x00: 'Sync',
    0x01: 'Delay_Req',
    0x08: 'Follow_Up',
    0x09: 'Delay_Resp',
    0x0b: 'Announce',
    0x0c: 'Signaling'
}

print("=" * 80)
print("Apple Proprietary PTP TLV Analysis")
print("=" * 80)

for name, payload in test_payloads.items():
    print(f"\n{name}")
    print("-" * 80)

    parsed = parse_ptp_message(payload)
    print(f"Message Type: {msg_type_names.get(parsed['msg_type'], 'Unknown')} (0x{parsed['msg_type']:02x})")
    print(f"Message Length: {parsed['msg_len']} bytes")
    print(f"Apple TLVs Found: {len(parsed['tlvs'])}")

    for i, tlv in enumerate(parsed['tlvs'], 1):
        print(f"\n  TLV #{i}:")
        print(f"    Organization: {tlv['org_id']} (Apple)")
        print(f"    Subtype: 0x{tlv['subtype']}")
        print(f"    Length: {tlv['length']} bytes")
        print(f"    Payload ({len(tlv['payload']) // 2} bytes):")
        print(format_payload(tlv['payload']))

print("\n" + "=" * 80)
print("Payload Analysis:")
print("=" * 80)

print("\nSubtype 0x000001 appears in Signaling messages:")
print("  Payload: 00 04 03 01 00 00 00 00 00 00 00 00 00 20 6f 2f")
print("  Possible structure:")
print("    00 04 - Unknown (4)")
print("    03 01 - Unknown (769)")
print("    00 00 00 00 00 00 00 00 00 - Padding/Reserved")
print("    20 6f 2f - Constant (0x206f2f)")

print("\nSubtype 0x000005 appears in Signaling messages:")
print("  Payload: 00 10 03 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 20 6f 2f")
print("  Possible structure:")
print("    00 10 - Unknown (16)")
print("    03 01 - Unknown (769)")
print("    00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 - Padding/Reserved")
print("    20 6f 2f - Constant (0x206f2f)")

print("\nSubtype 0x000004 appears in Follow_Up messages:")
print("  Payload: 14 14 7d e8 54 98 00 08 00 00")
print("  Possible structure:")
print("    14 14 7d e8 54 98 00 08 - Clock Identity (matches master clock ID!)")
print("    00 00 - Port ID or flags")

print("\n" + "=" * 80)
