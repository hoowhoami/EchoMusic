# EchoMusic Vendor Notes

This directory vendors `airplay2-rs` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/lmcgartland/airplay2-rs
- Vendored commit: `097727d` (2026-10-02, "Merge pull request #12 from noah-gabel/fix/ntp-busy-loop")
- License: GPL-3.0-or-later (upstream relicensed in `a2f980c`, 2026-09-14)

Verified by diffing `crates/airplay-discovery/src/lib.rs` against `097727d` — byte-identical.

## EchoMusic Compatibility Patches

- `crates/airplay-discovery/src/browser.rs` — browse and scan `_airplay-p2p._tcp` in addition to `_airplay._tcp` and `_raop._tcp`. Upstream defines `AIRPLAY_P2P_SERVICE_TYPE` in `src/lib.rs` but never subscribes to it.
- `crates/airplay-client/src/client.rs` — device-field adjustments.
- `crates/airplay-audio/src/rtp.rs`, `crates/airplay-audio/src/live_decoder.rs` — audio pipeline adjustments.

## EchoMusic Upstream-Derived Patch

`crates/airplay-discovery/src/browser.rs` additionally deviates from upstream to fix a hang. This is **not** an EchoMusic feature — it is a bug fix against upstream behaviour, kept here until it can be upstreamed.

The `async_stream` generator returned by `browse()` contains no await point that can resolve to `Pending`: `Receiver::recv_timeout` is a blocking call, and `handle_service_event(...).await` only runs when an event actually arrives. On a network with **no** AirPlay devices no event ever arrives, so the generator spins inside a single `poll_next` without yielding.

Consumers that combine `stream.next()` with a timeout via `tokio::select!` therefore never regain control — `tokio::select!` only re-checks its other branches when the polled branch returns `Pending`, so the deadline sleep is never polled and the timeout is silently ignored. `echo-airplay`'s `browse_devices` was affected: `discover(3000)` and `discoverEach(3000)` both hung indefinitely.

The patch adds `tokio::task::yield_now().await` once per loop iteration, keeping the stream cooperative so the caller's deadline can fire. Verified: a 3s browse returns after ~3.0s, a 5s browse after ~5.0s.

Note that this only reproduces **without** AirPlay devices present. With a device on the network an event arrives, the generator yields, and the stream returns `Pending` between events — so the timeout appears to work. Testing against a real speaker will not catch it.

## Preferred Alternative to the Patch

`ServiceBrowser::scan(timeout)` already bounds itself with a wall-clock check (`start.elapsed() < timeout`) rather than relying on the consumer, so it is immune to this bug. `echo-airplay` therefore routes `discover()` through `scan()` and only consumes the `browse()` stream when a progress callback is registered:

```rust
// native/echo-airplay/src/session.rs, browse_devices()
if progress.is_none() {
    let devices = browser.scan(timeout).await?;
    // ...
    return Ok(devices);
}
// ... progress path consumes browser.browse() and therefore needs the patch
```

`scan()` reports no incremental progress, which is why the `discoverEach` path cannot use it — that API exists specifically to surface devices as they are found.

## Local Usage

```toml
# native/echo-airplay/Cargo.toml
airplay-client = { path = "../echo-upnp/vendor/airplay2-rs/crates/airplay-client" }
airplay-audio = { path = "../echo-upnp/vendor/airplay2-rs/crates/airplay-audio" }
airplay-discovery = { path = "../echo-upnp/vendor/airplay2-rs/crates/airplay-discovery" }
airplay-core = { path = "../echo-upnp/vendor/airplay2-rs/crates/airplay-core" }
```

## Refreshing

Do not remove these patches during an upstream refresh — in particular the `yield_now()` in `browser.rs`. If a future upstream release makes `browse()` cooperative, drop the patch and route `discoverEach` through a progress-aware path of its own.

Upstream issue #8 (`Encrypted RTSP response parsing hangs/times out`) is an unrelated hang in a different crate; do not assume one supersedes the other.