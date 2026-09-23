#!/usr/bin/env python3
"""
AirPlay 2 Pairing Diagnostic Tool

This script tests various pairing flows against a real AirPlay device
to determine what protocols it supports and what the correct message
formats are.

Usage:
    python3 airplay_pairing_diag.py <device_ip> [port]
"""

import socket
import sys
import os
from typing import Optional, Tuple
import struct

# Try to import crypto libraries
try:
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    from cryptography.hazmat.primitives import hashes
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False
    print("Warning: cryptography not installed. Some tests will be skipped.")
    print("Install with: pip install cryptography")


def hexdump(data: bytes, prefix: str = "") -> str:
    """Format bytes as hex string."""
    return prefix + data.hex()


def parse_tlv8(data: bytes) -> dict:
    """Parse TLV8 encoded data."""
    result = {}
    i = 0
    while i < len(data):
        if i + 2 > len(data):
            break
        tag = data[i]
        length = data[i + 1]
        if i + 2 + length > len(data):
            break
        value = data[i + 2:i + 2 + length]
        
        # Handle fragmented TLVs (same tag appears consecutively)
        if tag in result:
            result[tag] += value
        else:
            result[tag] = value
        i += 2 + length
    return result


def encode_tlv8(items: list) -> bytes:
    """Encode items as TLV8. Items is list of (tag, value) tuples."""
    result = b""
    for tag, value in items:
        if isinstance(value, int):
            value = bytes([value])
        elif isinstance(value, str):
            value = value.encode('utf-8')
        
        # Split into 255-byte chunks if needed
        while len(value) > 255:
            result += bytes([tag, 255]) + value[:255]
            value = value[255:]
        result += bytes([tag, len(value)]) + value
    return result


def send_request(sock: socket.socket, method: str, path: str, 
                 headers: dict, body: bytes = b"") -> Tuple[int, dict, bytes]:
    """Send HTTP/RTSP request and return response."""
    # Build request
    request = f"{method} {path} HTTP/1.1\r\n"
    for key, value in headers.items():
        request += f"{key}: {value}\r\n"
    if body:
        request += f"Content-Length: {len(body)}\r\n"
    request += "\r\n"
    
    # Send
    sock.sendall(request.encode() + body)
    
    # Receive response
    response = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        response += chunk
        # Check if we have full headers
        if b"\r\n\r\n" in response:
            header_end = response.index(b"\r\n\r\n") + 4
            headers_text = response[:header_end].decode('utf-8', errors='replace')
            
            # Parse Content-Length
            content_length = 0
            for line in headers_text.split("\r\n"):
                if line.lower().startswith("content-length:"):
                    content_length = int(line.split(":")[1].strip())
                    break
            
            # Check if we have full body
            if len(response) >= header_end + content_length:
                break
    
    # Parse response
    if not response:
        return 0, {}, b""
    
    header_end = response.index(b"\r\n\r\n") + 4
    headers_text = response[:header_end].decode('utf-8', errors='replace')
    body = response[header_end:]
    
    # Parse status
    status_line = headers_text.split("\r\n")[0]
    status_code = int(status_line.split()[1])
    
    # Parse headers
    resp_headers = {}
    for line in headers_text.split("\r\n")[1:]:
        if ": " in line:
            key, value = line.split(": ", 1)
            resp_headers[key.lower()] = value
    
    return status_code, resp_headers, body


def test_get_info(host: str, port: int) -> dict:
    """Test GET /info endpoint."""
    print("\n=== Testing GET /info ===")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
    }
    
    status, resp_headers, body = send_request(sock, "GET", "/info", headers)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    
    # Try to find interesting fields
    if b"pk" in body:
        pk_pos = body.find(b"pk")
        print(f"  Found 'pk' at position {pk_pos}")
        # Try to extract hex after pk
        snippet = body[pk_pos:pk_pos+100]
        print(f"  Snippet: {snippet[:50]}...")
    
    if b"features" in body:
        print("  Device supports 'features' field")
    
    return {"status": status, "body": body}


def test_pair_setup_transient(host: str, port: int) -> dict:
    """Test transient pair-setup (32-byte Ed25519 exchange)."""
    print("\n=== Testing Transient pair-setup (32 bytes) ===")
    
    if not CRYPTO_AVAILABLE:
        print("  Skipped: cryptography not available")
        return {"status": -1}
    
    # Generate Ed25519 key pair
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )
    
    print(f"  Our Ed25519 public key: {public_key.hex()}")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/octet-stream",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-setup", 
                                               headers, public_key)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    if body:
        print(f"  Response hex: {body[:64].hex()}...")
    
    return {"status": status, "body": body}


def test_pair_setup_tlv8_m1(host: str, port: int) -> dict:
    """Test TLV8-encoded pair-setup M1 (SRP start)."""
    print("\n=== Testing TLV8 pair-setup M1 (SRP) ===")
    
    # Build M1: Method=0x00, State=0x01
    m1 = encode_tlv8([
        (0x00, 0x00),  # Method: Pair-Setup
        (0x06, 0x01),  # State: M1
    ])
    
    print(f"  M1 hex: {m1.hex()}")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/x-apple-binary-plist",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-setup", 
                                               headers, m1)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    
    if status == 200 and body:
        tlv = parse_tlv8(body)
        print(f"  TLV tags: {list(tlv.keys())}")
        if 0x06 in tlv:
            print(f"  State: {tlv[0x06].hex()}")
        if 0x02 in tlv:
            print(f"  Salt: {len(tlv[0x02])} bytes")
        if 0x03 in tlv:
            print(f"  PublicKey: {len(tlv[0x03])} bytes")
    
    return {"status": status, "body": body}


def test_pair_setup_tlv8_m1_with_flags(host: str, port: int) -> dict:
    """Test TLV8-encoded pair-setup M1 with Flags (transient mode)."""
    print("\n=== Testing TLV8 pair-setup M1 with Flags=0x01 (transient) ===")
    
    # Build M1: Method=0x00, State=0x01, Flags=0x01 (transient)
    m1 = encode_tlv8([
        (0x00, 0x00),  # Method: Pair-Setup
        (0x06, 0x01),  # State: M1
        (0x13, 0x01),  # Flags: Transient
    ])
    
    print(f"  M1 hex: {m1.hex()}")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/x-apple-binary-plist",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-setup", 
                                               headers, m1)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    
    if status == 200 and body:
        tlv = parse_tlv8(body)
        print(f"  TLV tags: {list(tlv.keys())}")
        if 0x06 in tlv:
            print(f"  State: {tlv[0x06].hex()}")
        if 0x03 in tlv:
            print(f"  PublicKey: {len(tlv[0x03])} bytes - THIS IS THE SERVER's Ed25519 PK!")
            print(f"  PublicKey hex: {tlv[0x03].hex()}")
    
    return {"status": status, "body": body}


def test_pair_verify_m1_standard(host: str, port: int) -> dict:
    """Test standard HomeKit pair-verify M1."""
    print("\n=== Testing Standard pair-verify M1 (TLV8) ===")
    
    if not CRYPTO_AVAILABLE:
        print("  Skipped: cryptography not available")
        return {"status": -1}
    
    # Generate X25519 (Curve25519) key pair for ECDH
    ecdh_private = X25519PrivateKey.generate()
    ecdh_public = ecdh_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )
    
    print(f"  Our ECDH public key: {ecdh_public.hex()}")
    
    # Build M1: State=0x01, PublicKey=ECDH_public
    m1 = encode_tlv8([
        (0x06, 0x01),  # State: M1
        (0x03, ecdh_public),  # PublicKey
    ])
    
    print(f"  M1 hex: {m1.hex()}")
    print(f"  M1 length: {len(m1)} bytes")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/octet-stream",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-verify", 
                                               headers, m1)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    
    if status == 200 and body:
        tlv = parse_tlv8(body)
        print(f"  TLV tags: {list(tlv.keys())}")
        if 0x06 in tlv:
            print(f"  State: {tlv[0x06].hex()}")
        if 0x03 in tlv:
            print(f"  Server ECDH PublicKey: {len(tlv[0x03])} bytes")
        if 0x05 in tlv:
            print(f"  EncryptedData: {len(tlv[0x05])} bytes")
    elif body:
        print(f"  Response hex: {body.hex()}")
    
    return {"status": status, "body": body, "ecdh_private": ecdh_private if CRYPTO_AVAILABLE else None}


def test_pair_verify_m1_with_identifier(host: str, port: int) -> dict:
    """Test pair-verify M1 with Identifier (Format 3)."""
    print("\n=== Testing pair-verify M1 with Identifier (Format 3) ===")
    
    if not CRYPTO_AVAILABLE:
        print("  Skipped: cryptography not available")
        return {"status": -1}
    
    # Generate Ed25519 identity
    ed_private = Ed25519PrivateKey.generate()
    ed_public = ed_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )
    
    # Generate X25519 for ECDH
    ecdh_private = X25519PrivateKey.generate()
    ecdh_public = ecdh_private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw
    )
    
    print(f"  Our Ed25519 public key (identifier): {ed_public.hex()}")
    print(f"  Our ECDH public key: {ecdh_public.hex()}")
    
    # Build M1 with Identifier (Ed25519 pk), PublicKey (ECDH), State, Flags
    m1 = encode_tlv8([
        (0x01, ed_public),  # Identifier: Ed25519 public key
        (0x03, ecdh_public),  # PublicKey: ECDH public key  
        (0x06, 0x01),  # State: M1
        (0x13, 0x01),  # Flags: Transient
    ])
    
    print(f"  M1 hex: {m1.hex()}")
    print(f"  M1 length: {len(m1)} bytes")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/octet-stream",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-verify", 
                                               headers, m1)
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response size: {len(body)} bytes")
    
    if status == 200 and body:
        tlv = parse_tlv8(body)
        print(f"  TLV tags: {list(tlv.keys())}")
        if 0x06 in tlv:
            print(f"  State: {tlv[0x06].hex()}")
        if 0x03 in tlv:
            print(f"  Server ECDH PublicKey: {len(tlv[0x03])} bytes")
        if 0x05 in tlv:
            print(f"  EncryptedData: {len(tlv[0x05])} bytes")
            print(f"  *** M2 received! Device accepts Format 3! ***")
    elif body:
        print(f"  Response hex: {body.hex()}")
    
    return {"status": status, "body": body}


def test_pair_pin_start(host: str, port: int) -> dict:
    """Test /pair-pin-start to request PIN display."""
    print("\n=== Testing /pair-pin-start ===")
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    sock.connect((host, port))
    
    headers = {
        "User-Agent": "AirPlay/409.16",
        "X-Apple-Device-ID": "0xAABBCCDDEEFF",
        "Content-Type": "application/x-apple-binary-plist",
    }
    
    status, resp_headers, body = send_request(sock, "POST", "/pair-pin-start", 
                                               headers, b"")
    sock.close()
    
    print(f"  Status: {status}")
    print(f"  Response: {body[:100] if body else '(empty)'}")
    
    if status == 200:
        print("  *** Device should now display a PIN! ***")
    
    return {"status": status, "body": body}


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 airplay_pairing_diag.py <device_ip> [port]")
        print("\nThis tool tests various AirPlay pairing flows to determine")
        print("what protocols a device supports.")
        sys.exit(1)
    
    host = sys.argv[1]
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 7000
    
    print(f"Testing AirPlay device at {host}:{port}")
    print("=" * 60)
    
    # Run diagnostic tests
    results = {}
    
    # 1. Get device info
    try:
        results["info"] = test_get_info(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["info"] = {"error": str(e)}
    
    # 2. Test transient pair-setup
    try:
        results["transient_setup"] = test_pair_setup_transient(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["transient_setup"] = {"error": str(e)}
    
    # 3. Test TLV8 pair-setup M1
    try:
        results["tlv8_setup_m1"] = test_pair_setup_tlv8_m1(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["tlv8_setup_m1"] = {"error": str(e)}
    
    # 4. Test TLV8 pair-setup M1 with Flags (transient mode)
    try:
        results["tlv8_setup_m1_flags"] = test_pair_setup_tlv8_m1_with_flags(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["tlv8_setup_m1_flags"] = {"error": str(e)}
    
    # 5. Test standard pair-verify M1
    try:
        results["verify_m1_standard"] = test_pair_verify_m1_standard(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["verify_m1_standard"] = {"error": str(e)}
    
    # 6. Test pair-verify M1 with Identifier
    try:
        results["verify_m1_identifier"] = test_pair_verify_m1_with_identifier(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["verify_m1_identifier"] = {"error": str(e)}
    
    # 7. Test /pair-pin-start
    try:
        results["pair_pin_start"] = test_pair_pin_start(host, port)
    except Exception as e:
        print(f"  Error: {e}")
        results["pair_pin_start"] = {"error": str(e)}
    
    # Summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    
    for test_name, result in results.items():
        status = result.get("status", "error")
        print(f"  {test_name}: {status}")
    
    print("\n" + "=" * 60)
    print("RECOMMENDATIONS")
    print("=" * 60)
    
    # Analyze results
    if results.get("tlv8_setup_m1_flags", {}).get("status") == 200:
        print("  ✓ Device supports transient pair-setup with Flags=0x01")
        print("    → Use this for pair-setup, then skip pair-verify")
        print("    → The shared secret comes from the Ed25519 key exchange")
    elif results.get("transient_setup", {}).get("status") == 200:
        print("  ✓ Device supports simple 32-byte transient setup")
    elif results.get("verify_m1_identifier", {}).get("status") == 200:
        print("  ✓ Device supports pair-verify Format 3 (with Identifier)")
        print("    → But you may need to do pair-setup first!")
    elif results.get("verify_m1_standard", {}).get("status") == 200:
        print("  ✓ Device supports standard pair-verify")
        print("    → You need to complete pair-setup first to register your key")
    elif results.get("pair_pin_start", {}).get("status") == 200:
        print("  ! Device requires PIN-based pairing")
        print("    → Use /pair-pin-start, then full SRP pair-setup")
    else:
        print("  ? Could not determine supported pairing method")
        print("    → Try packet capture with a real Apple device")


if __name__ == "__main__":
    main()
