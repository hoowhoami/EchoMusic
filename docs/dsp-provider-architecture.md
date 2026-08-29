# DSP Provider Architecture

## Goal

Keep playback reliability in EchoMusic and make complex effects replaceable without putting a
provider-specific implementation in the player core.

```text
FFmpeg decode -> format conversion -> DspHost -> tempo -> output gain -> device output
                                      |
                         +------------+------------+
                         |                         |
                   Builtin Basic DSP        Native Provider
```

The native provider is always loaded in the player process. There is no sidecar protocol or PCM IPC.

Per-preset controls, persistence and runtime acknowledgement are described in
[Provider settings UI](dsp-provider-settings.md).

## Responsibilities

### Player Core

- FFmpeg demux/decode and resampling
- seek, generation, gapless boundaries and source-frame accounting
- output device lifecycle and clock
- provider lifecycle, deadline checks and error recovery
- final output format conversion

### Builtin Basic DSP

- 10-band parametric EQ with measured cascade headroom and click-free updates
- generic mono, stereo and true-stereo convolution with latency-aligned dry/wet mixing
- automatic IRS frequency-response headroom and stereo-linked peak protection
- deterministic latency reporting, EOF tail draining and boundary reset
- stable cross-platform effects that do not depend on a proprietary preset format

### Provider

- provider-specific preset parsing and resource loading
- effect graph and mode selection
- DSP state, latency and tail draining
- provider-specific parameters and capabilities

Provider-specific behavior belongs to a provider. EchoMusic Basic DSP never interprets VPF. An
external provider may opt into VPF by declaring the resource kind in its manifest; the Host passes
the resource through without understanding its binary format.

The Provider owns the complete DSP graph while it is active. Host EQ values remain persisted, but
the Host equalizer is bypassed and is not layered before or after Provider processing. A Provider
that implements its own EQ therefore cannot be equalized twice accidentally; the saved Host EQ is
restored when playback returns to Builtin DSP.

## Builtin DSP Contract

Basic DSP is the reliable fallback and generic processing path, not a compatibility layer for a
specific vendor. IRS files are decoded and prepared off the streaming path; steady-state EQ,
convolution and limiting do not allocate. Its convolution mix is adjustable from 0% (latency-aligned
dry signal) to 100% (complete convolution output), with a product default of 50%. Downloaded
resources keep settings under their stable effect ID; newly
imported local resources use a SHA-256 content ID, so the user override survives restarts and
re-imports without modifying the audio file. Provider resources do not use this Host mix because
their mixing semantics belong to the Provider.

The partitioned convolver uses a 256-frame early FFT block, so it has an algorithmic latency of
255 frames (about 5.3 ms at 48 kHz). This is not an arbitrary delay: the dry path is delayed by the
latency reported by the active convolver before dry/wet mixing. Removing that compensation would
mix time-shifted copies and create comb filtering at intermediate strengths.

Mono IRS files are expanded to stereo. Two-channel IRS files are routed as `L→L, R→R`.
Four-channel true-stereo files use the encoded
channel order `[L→L, L→R, R→L, R→R]` (`[LL, LR, RL, RR]`). When decoding a multichannel IRS, the
Host preserves the input channel layout whenever the channel count is unchanged. This prevents
FFmpeg from treating a discrete true-stereo matrix as a default surround-speaker layout and
remixing or dropping channels. Files using a different four-channel convention must be converted
to `[LL, LR, RL, RR]` before import. Basic DSP accepts only mono, stereo and four-channel
true-stereo IRS files; ambiguous 3-channel and surround layouts are rejected instead of being
silently remixed. IRS content longer than eight seconds is also rejected rather than truncated.

Before partitioning, the Host measures the oversampled frequency response. For true-stereo input,
the per-output matrix row sum provides a worst-case peak bound when both input channels can reach
full scale. Responses above unity receive automatic pre-limiter headroom up to a 0 dB linear peak;
unity and quieter responses are left unchanged. The linked limiter and final soft limiter handle
residual numeric and reconstruction peaks. The mix, measured peak, applied headroom and IRS
duration are exposed in the audio graph snapshot; preparation details are also written to the
playback log.

The EQ measures the complete biquad cascade and applies its headroom before filtering. Live EQ
changes crossfade the old and new filter states over 15 ms. IRS changes use the same transition
window after the new convolution and limiter latency, avoiding an abrupt non-zero onset after the
output queue is re-primed.

At a real EOF, Basic DSP zero-pads partial convolution blocks, emits the complete IRS decay and
drains its lookahead limiter before the tempo engine is finalized. A gapless track boundary resets
the effect instead: carrying the previous track's reverb into the next track is intentionally not
part of the gapless contract. Re-selecting different content at the same path is detected through a
content fingerprint rather than path identity alone.

## C ABI

The ABI is intentionally C and opaque. Providers must not expose C++ classes or Rust types.

```c
typedef struct EchoDspConfig {
    uint32_t abi_version;          /* 2 */
    uint32_t sample_rate;
    uint32_t channels;
    uint32_t preferred_block_frames;
    uint32_t mode;                 /* 0=headphone, 1=speaker */
    const char *resource_json;     /* UTF-8 JSON array of opaque resources, nullable */
    const char *preset_json;       /* UTF-8, nullable */
} EchoDspConfig;

typedef struct EchoDspInfo {
    uint32_t abi_version;
    uint32_t latency_frames;
    uint32_t preferred_block_frames;
    uint32_t max_channels;
    const char *provider_id;
    const char *provider_version;
    const char *manifest_json;
    const char *state_json;
} EchoDspInfo;

typedef struct EchoDspApi {
    uint32_t abi_version;
    void *(*create)(const EchoDspConfig *, EchoDspInfo *);
    int (*process)(void *, float *, uint32_t frames, uint32_t channels);
    int (*drain)(void *, float *, uint32_t capacity_frames, uint32_t *written_frames);
    int (*reset)(void *);
    int (*configure)(void *, const char *preset_json); /* updates runtime state */
    const char *(*get_state_json)(void *);
    void (*destroy)(void *);
} EchoDspApi;

const EchoDspApi *echo_dsp_get_api(void);
```

`process` is in-place and must not allocate, block, panic, throw exceptions, or change the number
of frames. Providers with internal buffering report their fixed latency and use `drain` at EOF.
`configure` is called on the realtime control path, never from `process`; it must update the graph
atomically from the audio thread's point of view. `get_state_json` returns a borrowed UTF-8 string
whose lifetime lasts until the next Provider call.

`EchoDspInfo.latency_frames` is the initial delay, not a writable host-owned pointer.
If `configure` changes the processing delay, the engine should publish the current frame count as
the optional top-level `state_json.latencyFrames` (integer, 0 through `UINT32_MAX`). After a
successful configuration, the Host refreshes this value for both graph delay compensation and
the descriptor. Missing/invalid values retain the previous delay for backward compatibility;
zero is a valid update. This JSON extension does not change the ABI v2 structure layout.

## Loading Rules

- Load only an explicit user-selected native provider path.
- Validate file architecture and ABI before creating an instance.
- Keep the dynamic library alive for the entire provider instance lifetime.
- Reject a provider that does not expose a complete API table.
- On create/configure/process failure, reset the graph and disable the provider; never mix stale
  provider output with Builtin DSP output.
- Before processing, the Host matches every resource's `kind` or file extension against the
  Provider manifest. A Provider that does not advertise a resource is rejected.
- A provider is not bundled, downloaded, or referenced by a hard-coded path.

## Effect Selection

```text
Builtin Basic + generic IRS       -> Builtin DSP
Provider + non-VPF audio resource -> selected Provider
  VPF resource + Provider           -> selected Provider
  VPF resource without Provider     -> explicit unsupported error
```

The UI consumes provider capabilities and does not render provider-specific controls when the
active provider does not advertise them.

`manifest_json` describes the modules and controls the Provider can implement. `state_json`
describes the current preset and its control policy. Neither document has fixed EchoMusic effect
names. Control IDs, value types, ranges, units, enum options, and ownership are provider-defined.
The Host only validates the common JSON envelope and treats unknown fields as opaque.

Every Provider manifest must include a stable, user-facing `displayName`. `provider_id` remains a
technical identifier and must not be used as the primary name in the UI. `description` and `vendor`
are optional presentation metadata. Older manifests without `displayName` remain loadable; the UI
falls back to `provider_id` for compatibility.

```json
{
  "schemaVersion": 1,
  "displayName": "Example Spatial Audio",
  "description": "Headphone and speaker spatial processing",
  "vendor": "Example Audio",
  "resources": [{ "kind": "impulse-response", "extensions": [".wav", ".irs"] }],
  "presets": [{ "id": "wide", "label": "Wide", "recommendedDevice": "headphone" }],
  "controls": []
}
```

Preset `recommendedDevice` is optional presentation metadata. `headphone` asks
the Host to show a headphone recommendation label; it does not disable speaker
mode or change DSP configuration. Unknown values are ignored for forward
compatibility.

```json
{
  "schemaVersion": 1,
  "effect": { "id": "preset-8061", "name": "Example" },
  "latencyFrames": 256,
  "controls": {
    "band.0.gain": { "type": "number", "value": 4.5, "unit": "dB", "ownership": "provider" },
    "room.enabled": { "type": "boolean", "value": true, "ownership": "provider" }
  },
  "opaque": { "providerSpecific": true }
}
```

`ownership` is one of the few Host-level concepts: `provider`, `host`, or `disabled`. Provider
control IDs and values are otherwise arbitrary JSON values. The graph snapshot exposes the
documents so the renderer never has to infer provider behavior from file extensions.

`ownership` applies to individual Provider settings only. Host EQ bypass and final output gain are
fixed graph semantics rather than runtime-negotiated policies: while a Provider is active it owns
the complete DSP graph, the Host preserves but does not apply its EQ values, and final user volume
remains in the Host output stage.

## Installed Provider Identity and Versions

The Provider ABI's `providerId` is the cross-platform logical identity. Source filenames and
absolute paths are never identities: filenames can collide or change, while paths are local
runtime details required only by `LoadLibrary`/`dlopen`.

Installed binaries are immutable versions addressed by their SHA-256 content hash under a
directory derived from the full `providerId` hash. Re-importing identical content reuses the
existing version without another write. Importing different content with the same `providerId`
creates and validates a candidate version, then advances provider metadata as a rollback-capable
transaction while activating it. A failed activation restores the previous metadata and binary.

Windows may keep the old and new immutable versions briefly because a loaded DLL cannot be
unlinked. The Host retries retirement in the background; successful unlink is the release signal
after `FreeLibrary`. POSIX platforms may unlink an old mapped version immediately. Startup garbage
collection resumes interrupted retirement after crashes. Enabling, disabling, inspecting, and
rebuilding an audio graph load an installed immutable version directly and do not create per-instance
disk shadow copies. Deleting the active Provider first submits a Basic DSP graph, then removes its
logical metadata immediately; physical binary retirement remains asynchronous.

Registry metadata is fail-closed for cleanup: a missing `provider.json` identifies an orphan that may
be collected, while unreadable, malformed, or newer-schema metadata preserves every binary and emits
a diagnostic. Content hashes must be canonical 64-character lowercase SHA-256 values and every
retirement path is constrained to its hashed Provider directory. Import, list/migration, and delete
transactions are serialized in the main process. Legacy flat-file migration runs at most once per app
process because inspection loads native code. Retirement retries are bounded, deduplicated, and log a
final failure for the next startup to retry.

## IPC Compatibility

The `setAudioEffect` IPC keeps its existing optional fields. A request without `providerPath` still
selects Builtin Basic DSP, so existing Basic DSP selections continue to work. A Basic DSP request
can include its normalized mix:

```json
{
  "impulseResponsePath": "...",
  "impulseResponseMix": 0.5
}
```

Provider requests use their own preset and resource contract:

```json
{
  "providerPath": ".../audio-provider.dll",
  "providerPresetJson": "...",
  "providerMode": "headphone",
  "providerResources": [{ "kind": "vpf", "path": ".../effect.vpf" }]
}
```

`impulseResponseMix` is a Basic DSP value normalized to `0..1`; it is ignored when a Provider owns
the effect graph. `providerMode` is optional and defaults to `speaker` on desktop. This IPC
compatibility statement does not mean that an ABI v1 native Provider can load under ABI v2; native
Providers must implement the ABI version advertised by `EchoDspApi`.
