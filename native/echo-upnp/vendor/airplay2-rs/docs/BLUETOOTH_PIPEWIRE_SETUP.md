# Bluetooth Audio via PipeWire/WirePlumber Setup

> **DEPRECATED**: This document is historical. The airplay-tui Bluetooth feature now uses **BlueALSA** instead of PipeWire for audio capture. See `BLUETOOTH_ALSA_EVALUATION.md` for the current setup.
>
> PipeWire's bluez5 plugin had issues with transport acquisition that caused silent audio capture. BlueALSA provides more reliable A2DP source handling.

## Overview

This document tracks the (unsuccessful) configuration attempts of Bluetooth A2DP Source audio streaming from a Pro-Ject HD turntable to a Raspberry Pi running PipeWire/WirePlumber.

## System Information

| Component | Version |
|-----------|---------|
| Device | Pro-Ject HD Turntable |
| MAC Address | 53:4A:52:FC:03:9F |
| Codec | aptX HD |
| Audio Format | S24LE, 48000 Hz, stereo |
| PipeWire | 1.4.2 |
| WirePlumber | 0.5.8 |
| Pi User | raspberry@raspberrypi.local |

## Configuration Applied

### WirePlumber BlueZ Config

**File:** `~/.config/wireplumber/wireplumber.conf.d/51-bluez-config.conf`

```conf
# WirePlumber 0.5.x format for BlueZ configuration
monitor.bluez.properties = {
  # Enable A2DP source (receive audio from external devices)
  bluez5.roles = [ a2dp_sink a2dp_source ]

  # Enable high-quality codecs
  bluez5.enable-sbc-xq = true
  bluez5.enable-hw-volume = true

  # Do not auto-switch profiles (we control this manually)
  bluez5.autoswitch-profile = false

  # Ensure connection info is available
  api.bluez5.connection-info = true
}

# Force Pro-Ject HD to use audio-gateway profile
monitor.bluez.rules = [
  {
    matches = [
      {
        device.name = "bluez_card.53_4A_52_FC_03_9F"
      }
    ]
    actions = {
      update-props = {
        bluez5.auto-connect = [ a2dp_source ]
        device.profile = "audio-gateway"
      }
    }
  }
]
```

## Verification

### Config Loading Confirmed

WirePlumber debug output shows the config is being loaded:

```
section 'monitor.bluez.properties' is used as-is from '/home/raspberry/.config/wireplumber/wireplumber.conf.d/51-bluez-config.conf'
Found best profile 'audio-gateway' (65536) for device 'bluez_card.53_4A_52_FC_03_9F'
Profile audio-gateway is already set on bluez_card.53_4A_52_FC_03_9F
```

### Device Properties

```bash
wpctl inspect <device_id>
```

Shows:
- `device.profile = "audio-gateway"` - WirePlumber property set correctly
- `bluez5.profile = "off"` - SPA bluez5 plugin reports "off" (see Known Issues)

## Current Behavior

### Working State (When Transport is Active)

When the turntable is actively streaming audio:

1. **Transport becomes "active":**
   ```bash
   busctl get-property org.bluez /org/bluez/hci0/dev_53_4A_52_FC_03_9F/fd12 \
     org.bluez.MediaTransport1 State
   # Returns: s "active"
   ```

2. **Audio stream appears in PipeWire:**
   ```
   Streams:
       88. bluez_input.53_4A_52_FC_03_9F.2
            79. output_FL > Dummy Output:playback_FL [active]
           111. output_FR > Dummy Output:playback_FR [active]
   ```

3. **Node properties show correct codec:**
   ```
   api.bluez5.codec = "aptx_hd"
   api.bluez5.profile = "a2dp-source"
   factory.name = "api.bluez5.a2dp.source"
   ```

### Non-Working State (Transport Idle)

When transport is "idle":
- No `bluez_input` stream appears
- `wpctl status` shows device but no audio source
- WirePlumber logs: `No routes selected to set on bluez_card.53_4A_52_FC_03_9F`

## Known Issues

### 1. Transport Property Empty

Even when the stream is active, the node shows:
```
api.bluez5.transport = ""
```

This empty transport property is why captured audio contains only silence (zeros). The node exists and is "running" but isn't connected to the actual BlueZ transport file descriptor.

### 2. bluez5.profile Shows "off"

The SPA bluez5 plugin property `bluez5.profile` shows "off" even when:
- WirePlumber's `device.profile` is set to "audio-gateway"
- The audio-gateway profile (index 65536) is available
- WirePlumber logs show "Profile audio-gateway is already set"

This disconnect between WirePlumber's view and SPA's view may be the root cause.

### 3. Transport State Dependency

The PipeWire node is only created when the BlueZ transport is in "active" state. The transport goes active when:
- The turntable initiates audio streaming
- Music is playing AND the turntable decides to send audio

Restarting WirePlumber while music is playing can cause the transport to go back to "idle".

## Debugging Commands

### Check Transport State
```bash
# Find transport path
busctl tree org.bluez | grep -E "fd[0-9]+"

# Check state
busctl get-property org.bluez /org/bluez/hci0/dev_53_4A_52_FC_03_9F/sep16/fdXX \
  org.bluez.MediaTransport1 State
```

### Check PipeWire Status
```bash
wpctl status
pw-cli ls Node | grep -i blue
pw-cli info <node_id>
```

### Debug WirePlumber
```bash
WIREPLUMBER_DEBUG=4 timeout 10 wireplumber 2>&1 | grep -i bluez
```

### Check Device Info
```bash
bluetoothctl info 53:4A:52:FC:03:9F
wpctl inspect <device_id>
```

## Troubleshooting Steps

### If No Audio Stream Appears

1. **Verify Bluetooth connection:**
   ```bash
   bluetoothctl info 53:4A:52:FC:03:9F | grep Connected
   ```

2. **Check transport state:**
   ```bash
   busctl tree org.bluez | grep fd
   # Then check state of found transport
   ```

3. **If transport is "idle":**
   - Ensure turntable is playing music
   - Try pause/unpause on turntable
   - Disconnect and reconnect Bluetooth from turntable side

4. **Restart WirePlumber (only if transport is active):**
   ```bash
   systemctl --user restart wireplumber
   ```

### If Audio is Silent (All Zeros)

The `api.bluez5.transport = ""` issue means PipeWire isn't reading from the actual BlueZ transport. This is an open issue being investigated.

## Next Steps

1. **Investigate SPA bluez5 transport acquisition** - Why is `api.bluez5.transport` empty even when the BlueZ transport is active?

2. **Consider alternative approaches:**
   - Direct BlueZ transport acquisition via custom code
   - Using `bluealsa` as an alternative to PipeWire's bluez5 plugin

3. **Test with different Bluetooth source devices** - Verify if this is device-specific or a general PipeWire/WirePlumber issue.

## References

- [PipeWire BlueZ5 Documentation](https://docs.pipewire.org/page_module_protocol_native.html)
- [WirePlumber Configuration](https://pipewire.pages.freedesktop.org/wireplumber/)
- [BlueZ D-Bus API](https://github.com/bluez/bluez/blob/master/doc/media-api.txt)
