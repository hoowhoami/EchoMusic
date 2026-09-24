use airplay_client::{Device, DeviceId};
use airplay_discovery::TxtRecordParser;
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader};
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const BROWSE_TIMEOUT_MS: u64 = 800;
const RESOLVE_TIMEOUT_MS: u64 = 900;
const ADDRESS_TIMEOUT_MS: u64 = 600;
const MAX_RESOLVE_COUNT: usize = 32;

struct BrowseEntry {
    service: &'static str,
    is_raop: bool,
    name: String,
}

struct ResolveRecord {
    name: String,
    is_raop: bool,
    host: String,
    port: u16,
    txt: HashMap<String, String>,
}

enum DiscoveryEvent {
    Browse(BrowseEntry),
    BrowseDone,
    Device(Option<Device>),
}

pub async fn discover_with_progress<F>(timeout: Duration, on_device: F) -> Vec<Device>
where
    F: FnMut(Device) + Send + 'static,
{
    #[cfg(target_os = "macos")]
    {
        tokio::task::spawn_blocking(move || discover_blocking(timeout, on_device))
            .await
            .unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = timeout;
        let _ = on_device;
        Vec::new()
    }
}

fn merge_device(existing: &Device, incoming: &Device) -> Device {
    if incoming.raop_port.is_some() && existing.raop_port.is_none() {
        return TxtRecordParser::merge_device_info(existing, incoming);
    }
    if existing.raop_port.is_some() && incoming.raop_port.is_none() {
        return TxtRecordParser::merge_device_info(incoming, existing);
    }
    let mut merged = existing.clone();
    for address in &incoming.addresses {
        if !merged.addresses.contains(address) {
            merged.addresses.push(*address);
        }
    }
    if merged.model.is_empty() {
        merged.model = incoming.model.clone();
    }
    if merged.public_key.is_none() {
        merged.public_key = incoming.public_key;
    }
    if merged.raop_port.is_none() {
        merged.raop_port = incoming.raop_port;
    }
    merged
}

#[cfg(target_os = "macos")]
fn discover_blocking<F>(timeout: Duration, mut on_device: F) -> Vec<Device>
where
    F: FnMut(Device),
{
    let browse_timeout = timeout.min(Duration::from_millis(BROWSE_TIMEOUT_MS));
    let started = Instant::now();
    let services = [
        ("_airplay._tcp", false),
        ("_raop._tcp", true),
        ("_airplay-p2p._tcp", false),
    ];
    let (event_tx, event_rx) = mpsc::channel();
    let mut browse_handles = Vec::new();
    for (service, is_raop) in services {
        let event_tx = event_tx.clone();
        browse_handles.push(thread::spawn(move || {
            let _ = stream_browse_service(service, is_raop, browse_timeout, event_tx.clone());
            let _ = event_tx.send(DiscoveryEvent::BrowseDone);
        }));
    }

    let mut browse_done = 0usize;
    let mut pending_resolves = 0usize;
    let mut started_resolves = 0usize;
    let mut seen_entries = HashSet::new();
    let mut devices: HashMap<DeviceId, Device> = HashMap::new();

    while (browse_done < services.len() || pending_resolves > 0) && started.elapsed() < timeout {
        let remaining = timeout.saturating_sub(started.elapsed());
        let wait = remaining.min(Duration::from_millis(50));
        let Ok(event) = event_rx.recv_timeout(wait) else {
            continue;
        };
        match event {
            DiscoveryEvent::Browse(entry) => {
                if started_resolves >= MAX_RESOLVE_COUNT {
                    continue;
                }
                let entry_key = format!("{}|{}", entry.service, entry.name);
                if !seen_entries.insert(entry_key) {
                    continue;
                }
                started_resolves += 1;
                pending_resolves += 1;
                let event_tx = event_tx.clone();
                thread::spawn(move || {
                    let device = resolve_entry(entry).and_then(device_from_record);
                    let _ = event_tx.send(DiscoveryEvent::Device(device));
                });
            }
            DiscoveryEvent::BrowseDone => browse_done += 1,
            DiscoveryEvent::Device(device) => {
                pending_resolves = pending_resolves.saturating_sub(1);
                let Some(device) = device else {
                    continue;
                };
                let (merged, changed) = upsert_device(&mut devices, device);
                if changed {
                    on_device(merged);
                }
            }
        }
    }
    drop(event_tx);
    for handle in browse_handles {
        let _ = handle.join();
    }
    devices.into_values().collect()
}

#[cfg(target_os = "macos")]
fn upsert_device(devices: &mut HashMap<DeviceId, Device>, device: Device) -> (Device, bool) {
    match devices.get(&device.id) {
        Some(existing) => {
            let merged = merge_device(existing, &device);
            let changed = !same_device(existing, &merged);
            devices.insert(device.id.clone(), merged.clone());
            (merged, changed)
        }
        None => {
            devices.insert(device.id.clone(), device.clone());
            (device, true)
        }
    }
}

#[cfg(target_os = "macos")]
fn same_device(a: &Device, b: &Device) -> bool {
    a.name == b.name
        && a.model == b.model
        && a.addresses == b.addresses
        && a.public_key == b.public_key
        && a.raop_port == b.raop_port
}

#[cfg(target_os = "macos")]
fn stream_browse_service(
    service: &'static str,
    is_raop: bool,
    timeout: Duration,
    event_tx: mpsc::Sender<DiscoveryEvent>,
) -> io::Result<()> {
    let mut child = Command::new("/usr/bin/dns-sd")
        .args(["-B", service, "local."])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Ok(());
    };
    let killer = thread::spawn(move || {
        thread::sleep(timeout);
        let _ = child.kill();
        let _ = child.wait();
    });

    let mut seen = HashSet::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let Some(name) = parse_browse_name_line(&line, service) else {
            continue;
        };
        if !seen.insert(name.clone()) {
            continue;
        }
        let _ = event_tx.send(DiscoveryEvent::Browse(BrowseEntry {
            service,
            is_raop,
            name,
        }));
    }
    let _ = killer.join();
    Ok(())
}

#[cfg(target_os = "macos")]
fn resolve_entry(entry: BrowseEntry) -> Option<ResolveRecord> {
    let output = run_dns_sd_until(
        &["-L", &entry.name, entry.service, "local."],
        Duration::from_millis(RESOLVE_TIMEOUT_MS),
        |output| parse_reachable(output).is_some() && !parse_txt(output).is_empty(),
    )
    .ok()?;
    let (host, port) = parse_reachable(&output)?;
    let txt = parse_txt(&output);
    Some(ResolveRecord {
        name: entry.name,
        is_raop: entry.is_raop,
        host,
        port,
        txt,
    })
}

#[cfg(target_os = "macos")]
fn device_from_record(record: ResolveRecord) -> Option<Device> {
    let addresses = resolve_addresses(&record.host);
    if addresses.is_empty() {
        return None;
    }
    if record.is_raop {
        TxtRecordParser::parse_raop_txt(&record.name, &record.txt, addresses, record.port).ok()
    } else {
        TxtRecordParser::parse_airplay_txt(&record.name, &record.txt, addresses, record.port).ok()
    }
}

#[cfg(target_os = "macos")]
fn run_dns_sd_until<F>(args: &[&str], timeout: Duration, done: F) -> io::Result<String>
where
    F: Fn(&str) -> bool,
{
    let mut child = Command::new("/usr/bin/dns-sd")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Ok(String::new());
    };
    let child = Arc::new(Mutex::new(child));
    let killer_child = Arc::clone(&child);
    let (stop_tx, stop_rx) = mpsc::channel();
    let killer = thread::spawn(move || {
        if stop_rx.recv_timeout(timeout).is_err() {
            if let Ok(mut child) = killer_child.lock() {
                let _ = child.kill();
            }
        }
    });

    let mut output = String::new();
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        output.push_str(&line);
        output.push('\n');
        if done(&output) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
            break;
        }
    }

    let _ = stop_tx.send(());
    let _ = killer.join();
    if let Ok(mut child) = child.lock() {
        let _ = child.wait();
    }
    Ok(output)
}

#[cfg(target_os = "macos")]
fn parse_browse_name_line(line: &str, service: &str) -> Option<String> {
    if !line.contains(" Add ") {
        return None;
    }
    let start = line.find(service)?;
    let name = line[start + service.len()..]
        .trim()
        .trim_start_matches('.')
        .trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(target_os = "macos")]
fn parse_reachable(output: &str) -> Option<(String, u16)> {
    for line in output.lines() {
        let marker = " can be reached at ";
        let Some(start) = line.find(marker) else {
            continue;
        };
        let mut target = line[start + marker.len()..].trim();
        if let Some(end) = target.find(" (") {
            target = &target[..end];
        }
        let Some((host, port)) = target.rsplit_once(':') else {
            continue;
        };
        let port = port.trim().parse::<u16>().ok()?;
        return Some((host.trim().trim_end_matches('.').to_string(), port));
    }
    None
}

#[cfg(target_os = "macos")]
fn parse_txt(output: &str) -> HashMap<String, String> {
    let mut txt = HashMap::new();
    for token in output.split_whitespace() {
        let Some((key, value)) = token.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || key.contains(':') {
            continue;
        }
        txt.insert(key.to_string(), value.trim_matches('"').to_string());
    }
    txt
}

#[cfg(target_os = "macos")]
fn resolve_addresses(host: &str) -> Vec<IpAddr> {
    let mut addresses = Vec::new();

    let Ok(output) = run_dns_sd_until(
        &["-G", "v4v6", host.trim_end_matches('.')],
        Duration::from_millis(ADDRESS_TIMEOUT_MS),
        |output| {
            output
                .split_whitespace()
                .any(|token| token.parse::<IpAddr>().is_ok())
        },
    ) else {
        return addresses;
    };
    for token in output.split_whitespace() {
        if let Ok(address) = token.parse::<IpAddr>() {
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
    }
    addresses
}
