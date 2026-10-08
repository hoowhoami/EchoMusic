# EchoMusic Vendor Notes

This directory vendors `rupnp` as ordinary source files, not as a Git submodule.

## Upstream

- Repository: https://github.com/jakobhellermann/rupnp
- Vendored source: crates.io `rupnp` **3.0.0** (the `v3.0.0` git tag does not exist upstream; tags stop at `1.0.0`)
- License: MIT OR Apache-2.0, as declared in the upstream `Cargo.toml.orig`

## EchoMusic Compatibility Patches

Verified against the pristine crates.io 3.0.0 sources.

- `src/utils.rs` — add `NETWORK_BODY_MAX_BYTES` (4 MiB) and `HyperBodyExt::bytes_limited()`. `bytes()` now caps by default instead of collecting the whole body.
- `src/error.rs` — add the `ResponseTooLarge(usize)` variant plus its `Display` and `source` arms.
- `src/device.rs` — fetch the device description through `bytes_limited(NETWORK_BODY_MAX_BYTES)`; add the `presentation_url()` getter behind `full_device_spec`.
- `src/service.rs` — `control_url` / `scpd_url` / `event_sub_url` widened from `pub(crate)` to `pub` so wrapper addons can expose absolute URLs.

The 4 MiB cap exists because device descriptions, SCPD documents and SOAP responses all come from discovery results, which are attacker-reachable on any local network.

## EchoMusic Upstream-Derived Patch

`src/service.rs` and `src/device.rs` additionally deviate from upstream to fix real-device compatibility. This is **not** an EchoMusic feature — it is a bug fix against upstream behaviour, kept here until it can be upstreamed.

- **Service endpoints are stored as `String` and resolved lazily.** Upstream parses `SCPDURL` / `controlURL` / `eventSubURL` into `http::uri::PathAndQuery` during `Service::from_xml`, which accepts root-relative paths only. Per the UPnP Device Architecture the endpoints may also be absolute or document-relative, and real devices routinely emit the latter. The Xiaomi speaker (小爱音箱-9205) ships `<SCPDURL>AVTransport1.xml</SCPDURL>` and `<controlURL>Queue1/control</controlURL>`, which upstream rejects with `Invalid response: path does not start with slash`.
- **`resolve_endpoint()` replaces `replace_url_path()`.** It implements RFC 3986 reference resolution against the description URL for all three forms. `http::Uri` in 1.x has no `join`, so the resolution is hand-rolled: split off `?query`, prepend `/` when missing, then `PathAndQuery::from_str`. Absolute endpoints whose authority differs from the description URL are rejected, so a device description cannot redirect control traffic off-host.
- **A single malformed service no longer fails the whole device.** `device.rs` previously collected services with `collect::<Result<_>>()?`, so one non-conforming `<service>` block aborted the entire `DeviceSpec`. Unparseable services and embedded devices are now skipped. A device whose `AVTransport` block parses is still usable, and `AVTransport` is what playback requires.

The wrapper addon skips services whose endpoints cannot be resolved rather than failing the whole load — see `native/echo-upnp/src/lib.rs`.

Endpoint resolution is covered by unit tests in `src/service.rs` (`mod endpoint_tests`). Run them with:

```bash
cd native/echo-upnp/vendor/rupnp
cargo test --release --features full_device_spec
```

## Local Usage

EchoMusic does **not** use `rupnp` for SSDP discovery or GENA eventing — those live in TypeScript (`src/main/mediaTransport/discovery.ts` and `genaReceiver.ts`) so the host can own the session clock and callbacks. `native/echo-upnp` uses this vendored tree only for device-description parsing and SOAP actions:

```toml
# native/echo-upnp/Cargo.toml
rupnp = { path = "vendor/rupnp", default-features = false, features = ["full_device_spec"] }
```

`default-features = false` drops the `subscribe`, `genawaiter` and `if-addrs` features: the module deliberately ships no subscription support, and `genawaiter` would require running `block_on` inside an async context.

## Refreshing

Do not remove these patches during an upstream refresh. Re-applying them after a version bump is the maintainer's job; verify against the pristine upstream sources before assuming a patch is still needed, and keep the `EchoMusic patch:` comments in the source so they stay greppable.