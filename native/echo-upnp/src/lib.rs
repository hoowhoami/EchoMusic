//! echo-upnp —— DLNA 薄 UPnP 底层（design §2、§5）。
//!
//! 包装 vendored rupnp 3.0.0 作为唯一 UPnP 实现：
//! - `loadDevice`：从受控的 SSDP Location 拉取设备描述，解析顶层服务端点并解析为绝对 URL。
//! - `action`：对指定服务执行 SOAP action，返回输出参数（JSON 字符串）。
//!
//! 发现（SSDP 主动/被动）与 GENA 订阅放在 TypeScript（discovery.ts / genaReceiver.ts），
//! 以便宿主统一会话时钟与回调。本模块不带订阅。
//!
//! 安全：只接受 http/https、无 userinfo；设备描述/SCPD/SOAP 响应均受 4MiB 上限
//! （vendored rupnp 补丁）；所有网络动作带超时，防止死设备悬挂会话。

#![deny(unsafe_code)]

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use napi::bindgen_prelude::*;
use napi_derive::napi;

static DEVICE_CACHE: OnceLock<Mutex<HashMap<String, CachedDevice>>> = OnceLock::new();

struct CachedDevice {
    device: rupnp::Device,
    fetched_at: Instant,
}

fn cache() -> &'static Mutex<HashMap<String, CachedDevice>> {
    DEVICE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

const DEVICE_CACHE_TTL: Duration = Duration::from_secs(300);
const DEVICE_CACHE_CAPACITY: usize = 64;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_SERVICES_IN_SNAPSHOT: usize = 64;

/// 描述 URL 校验（与 TS 宿主策略一致）：
/// - scheme ∈ {http, https}；
/// - 无 userinfo（`user:pass@`）；
/// - host 非空。
/// 纯文本扫描即可——不依赖 http::Uri 的（跨版本易变）API。
/// 描述 URL 校验（与 TS 宿主策略一致，纯字符串扫描以回避 http::Uri API 易变）：
/// - scheme ∈ {http, https}；
/// - 无 userinfo（形如 `user:pass@`）；
/// - host 非空。
fn validate_description_url(raw: &str) -> Result<String> {
    let scheme_off = raw.find("://").ok_or_else(|| Error::from_reason("missing scheme:// in URL"))?;
    let scheme = &raw[..scheme_off];
    if scheme != "http" && scheme != "https" {
        return Err(Error::from_reason(format!("unsupported scheme: {scheme}")));
    }
    let authority = raw[scheme_off + 3..].split("/").next().unwrap_or_default();
    if authority.is_empty() {
        return Err(Error::from_reason("URL has no host"));
    }
    if authority.contains('@') {
        return Err(Error::from_reason("device URL must not contain userinfo"));
    }
    Ok(raw.to_string())
}

async fn fetch_device(description_url: &str) -> Result<rupnp::Device> {
    let uri = http::Uri::from_str(description_url).map_err(|e| Error::from_reason(format!("invalid description URL: {e}")))?;
    let device = tokio::time::timeout(NETWORK_TIMEOUT, rupnp::Device::from_url(uri))
        .await
        .map_err(|_| Error::from_reason("device description fetch timed out"))?
        .map_err(|e| Error::from_reason(format!("device description failed: {e}")))?;
    Ok(device)
}

fn cache_device(url: &str, device: rupnp::Device) {
    let now = Instant::now();
    let mut cache = cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.retain(|_, e| e.fetched_at.elapsed() < DEVICE_CACHE_TTL);
    if cache.len() >= DEVICE_CACHE_CAPACITY {
        // 容量满：逐出最旧。
        if let Some(evict) = cache.iter().min_by_key(|(_, e)| e.fetched_at).map(|(k, _)| k.clone()) {
            cache.remove(&evict);
        }
    }
    cache.insert(url.to_string(), CachedDevice { device, fetched_at: now });
}

fn get_cached_device(url: &str) -> Option<rupnp::Device> {
    let cache = cache().lock().unwrap_or_else(|p| p.into_inner());
    cache.get(url).and_then(|e| {
        if e.fetched_at.elapsed() < DEVICE_CACHE_TTL {
            Some(e.device.clone())
        } else {
            None
        }
    })
}

#[napi(object)]
pub struct UpnpServiceEndpoint {
    pub service_id: String,
    pub service_type: String,
    pub control_url: String,
    pub event_sub_url: String,
    pub scpd_url: String,
}

#[napi(object)]
pub struct UpnpDeviceSnapshot {
    pub description_url: String,
    pub device_type: String,
    pub friendly_name: String,
    pub manufacturer: String,
    pub manufacturer_url: Option<String>,
    pub model_name: String,
    pub model_description: Option<String>,
    pub model_number: Option<String>,
    pub model_url: Option<String>,
    pub serial_number: Option<String>,
    pub udn: String,
    pub upc: Option<String>,
    pub presentation_url: Option<String>,
    pub services: Vec<UpnpServiceEndpoint>,
}

#[napi(js_name = "loadDevice")]
#[allow(non_snake_case)]
pub async fn load_device(description_url: String) -> Result<UpnpDeviceSnapshot> {
    let url = validate_description_url(&description_url)?;
    let device = fetch_device(&url).await?;

    let device_type = device.device_type().to_string();
    let friendly_name = device.friendly_name().to_string();
    cache_device(&url, device.clone());

    let base = device.url().clone();
    let mut services: Vec<UpnpServiceEndpoint> = Vec::new();
    for service in device.services() {
        if services.len() >= MAX_SERVICES_IN_SNAPSHOT {
            break;
        }
        services.push(UpnpServiceEndpoint {
            service_id: service.service_id().to_string(),
            service_type: service.service_type().to_string(),
            control_url: service.control_url(&base).to_string(),
            event_sub_url: service.event_sub_url(&base).to_string(),
            scpd_url: service.scpd_url(&base).to_string(),
        });
    }

    Ok(UpnpDeviceSnapshot {
        description_url: url,
        device_type,
        friendly_name,
        manufacturer: device.manufacturer().to_string(),
        manufacturer_url: device.manufacturer_url().map(ToString::to_string),
        model_name: device.model_name().to_string(),
        model_description: device.model_description().map(ToString::to_string),
        model_number: device.model_number().map(ToString::to_string),
        model_url: device.model_url().map(ToString::to_string),
        serial_number: device.serial_number().map(ToString::to_string),
        udn: device.udn().to_string(),
        upc: device.upc().map(ToString::to_string),
        presentation_url: device.presentation_url().map(ToString::to_string),
        services,
    })
}

fn find_service<'a>(device: &'a rupnp::Device, service_id: &str) -> Result<&'a rupnp::Service> {
    device
        .services()
        .iter()
        .find(|s| s.service_id() == service_id)
        .ok_or_else(|| Error::from_reason(format!("service not found: {service_id}")))
}

#[napi(js_name = "action")]
#[allow(non_snake_case)]
pub async fn action(description_url: String, service_id: String, action_name: String, args_xml: String) -> Result<String> {
    let url = validate_description_url(&description_url)?;
    let device = match get_cached_device(&url) {
        Some(d) => d,
        None => {
            let d = fetch_device(&url).await?;
            cache_device(&url, d.clone());
            d
        }
    };

    let service = find_service(&device, &service_id)?;
    let base = device.url().clone();
    let result = tokio::time::timeout(NETWORK_TIMEOUT, service.action(&base, &action_name, &args_xml))
        .await
        .map_err(|_| Error::from_reason(format!("action {action_name} timed out")))?
        .map_err(|e| Error::from_reason(format!("action {action_name} failed: {e}")))?;

    serde_json::to_string(&result).map_err(|e| Error::from_reason(format!("serialize failed: {e}")))
}

/// 清空设备缓存（退出/重扫时调用；幂等）。
#[napi(js_name = "clearDeviceCache")]
pub fn clear_device_cache() {
    cache().lock().unwrap_or_else(|p| p.into_inner()).clear();
}
