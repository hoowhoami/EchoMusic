# Pair_ap Group Formation Plan (Implementation Outline)

Goal: define a concrete, step-by-step plan to implement multiroom/group formation
that mirrors how Owntone handles it, without changing code yet.

## Scope (This Plan)
- Group formation and membership orchestration (leader + peers)
- RTSP control flow: `SETPEERS`, `SETUP`, and group UUID propagation
- Timing synchronization requirements for multiroom (PTP hooks)
- Tests and instrumentation

## Findings from Owntone (Concrete Behavior)
- `SETPEERS` is sent during the “start playback” RTSP sequence, after session
  `SETUP` and `RECORD`, and before stream `SETUP` and initial volume.
- `SETPEERS` payload is a binary plist array of peer addresses:
  - First entry: remote device address (`rs->address`)
  - Second entry: local sender address (`rs->local_address`)
  - Example (conceptual):
    - `["192.168.1.10", "192.168.1.50"]`
- `SETPEERS` request path is `/peer-list-changed`.
- Session `SETUP` includes `deviceID`, `sessionUUID`, `timingPort`, and
  `timingProtocol` (set to `"NTP"` in Owntone).
- No explicit group UUID headers/payloads were found in Owntone’s RTSP sender;
  group-related fields (`gid`, `igl`, `gcgl`) appear only in TXT record examples.
- Owntone’s `airplay_session` struct has no group UUID/leader fields; grouping is
  implied only by the `SETPEERS` address list.

## Owntone Start Playback Request Order (Exact)
Owntone’s AirPlay start sequence issues requests in this order:
1) `SETUP` (session) → payload dict with `deviceID`, `sessionUUID`, `timingPort`, `timingProtocol`
2) `RECORD`
3) `SETPEERS` → `/peer-list-changed` with plist array `[remote_addr, local_addr]`
4) `SETUP` (stream) → payload with stream parameters and `shk` audio key
5) `SET_PARAMETER` (volume) last

## References in This Repo (Current State)
- Discovery group parsing: `crates/airplay-discovery/src/parser.rs`
- Group fields in device model: `crates/airplay-core/src/device.rs`
- RTSP group UUID plumbing and `SETPEERS` builder: `crates/airplay-rtsp/src/session.rs`
- Timing crate stubs: `crates/airplay-timing/src/ptp.rs`
- Client group API stubs: `crates/airplay-client/src/group.rs`

## Plan (Based on Owntone)

### Phase 0: Confirm Owntone Behavior (Done)
1) Verified `SETPEERS` request sequence and payload structure in:
   - `src/outputs/airplay.c`:
     - `payload_make_setpeers` creates a plist array of two strings:
       remote address and local address.
     - `airplay_seq_request` sends `SETPEERS` at start of playback after
       session `SETUP` and `RECORD`.
2) Next, confirm if Owntone sets any group UUID in headers or payloads elsewhere.

### Phase 1: Group Formation Design
1) Define a “group session” struct in `airplay-client` (no code changes in this step).
2) Confirm desired leader selection policy:
   - Prefer device with `is_group_leader` from Bonjour.
   - Fallback: first device in user selection.
3) Define how `group_uuid` is created:
   - Use existing device `gid` when available.
   - Otherwise generate and assign from the leader.
4) Decide member lifecycle:
   - Create group with leader.
   - Add peers (order based on `pair_ap`).
   - Remove peers/disband group.

### Phase 2: RTSP Group Flow (Mirror Owntone)
1) Leader initiates RTSP session:
   - Send `OPTIONS`.
   - Send session `SETUP` (plist dict with `deviceID`, `sessionUUID`,
     `timingPort`, `timingProtocol`).
   - Send `RECORD`.
   - Send `SETPEERS` with peer address array (remote + local).
   - Use consistent `group_uuid` and set leader flags.
2) Each peer session:
   - Ensure pairing/encryption established.
   - Apply group UUID in `SETUP` or related requests.
3) Confirm any required per-peer requests in `pair_ap`:
   - `GET /info` or `SET_PARAMETER` with group metadata.
   - Additional headers required for multiroom.

### Phase 3: Timing and Sync
1) Wire PTP timing hooks into RTSP/audio pipeline:
   - Ensure clock sync happens before audio start.
2) Define “start time” coordination across group:
   - Determine if leader announces start timestamps.
   - Confirm usage of buffered audio mode (PT=103) in multiroom.
3) Add recovery behavior:
   - If PTP sync fails, abort group setup with a clear error.

### Phase 4: Error Handling & Telemetry
1) Add structured logs (leader/peer, group UUID, member list).
2) Add a diagnostic dump for RTSP requests/responses during group setup.
3) Define retry logic for `SETPEERS` failures:
   - Exponential backoff or immediate fail (match `pair_ap`).

### Phase 5: Tests
1) Unit tests:
   - Group UUID generation/propagation.
   - `SETPEERS` payload encoding and header correctness.
2) Integration tests:
   - Mock RTSP server with expected group formation flow.
3) Golden tests:
   - Compare generated RTSP payloads with captured `pair_ap` samples.

## Deliverables (When Implemented)
- `airplay-client` group orchestration uses `SETPEERS` per `pair_ap`.
- RTSP group requests identical to `pair_ap` (headers + payloads).
- PTP timing invoked before audio start.
- Logs + tests cover group formation and failure modes.

## Open Questions
- Does Owntone include any group UUID or group flags in RTSP headers?
- Is `SETPEERS` sent to every device in the group or only the leader?
- Are extra `SET_PARAMETER` metadata calls needed for HomePod multiroom?
- Are IPv6 addresses required in `SETPEERS` for some devices?
