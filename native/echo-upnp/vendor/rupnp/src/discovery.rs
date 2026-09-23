use crate::{Device, Error, Result};
use futures_util::stream::{Stream, StreamExt, TryStreamExt};
use ssdp_client::SearchTarget;
use std::time::Duration;

/// Discovers UPnP devices on the network.
///
/// # Example usage:
/// ```rust,no_run
/// use futures::prelude::*;
/// use std::time::Duration;
/// use rupnp::ssdp::SearchTarget;
///
/// # async fn discover() -> Result<(), rupnp::Error> {
/// let devices = rupnp::discover(&SearchTarget::RootDevice, Duration::from_secs(3), None).await?;
/// let mut devices = std::pin::pin!(devices);
///
/// while let Some(device) = devices.try_next().await? {
///     println!(
///         "{} - {} @ {}",
///         device.device_type(),
///         device.friendly_name(),
///         device.url()
///     );
/// }
///
/// # Ok(())
/// # }
/// ```
// TODO: doc include once stable
pub async fn discover(
    search_target: &SearchTarget,
    timeout: Duration,
    ttl: Option<u32>,
) -> Result<impl Stream<Item = Result<Device>>> {
    return discover_with_properties(search_target, timeout, ttl, &[]).await;
}

/// Discovers UPnP devices on the network and saves extra_fields in device descriptions
///
/// # Example usage:
/// ```rust,no_run
/// use futures::prelude::*;
/// use std::time::Duration;
/// use rupnp::ssdp::SearchTarget;
///
/// # async fn discover_with_properties() -> Result<(), rupnp::Error> {
/// let devices = rupnp::discover_with_properties(&SearchTarget::RootDevice, Duration::from_secs(3), None, &["manufacturer", "manufacturerURL"]).await?;
/// let mut devices = std::pin::pin!(devices);
///
/// while let Some(device) = devices.try_next().await? {
///     println!(
///         "{} - {} @ {}",
///         device.device_type(),
///         device.get_extra_property("manufacturer").unwrap_or_default(),
///         device.get_extra_property("manufacturerURL").unwrap_or_default()
///     );
/// }
///
/// # Ok(())
/// # }
/// ```
pub async fn discover_with_properties<'a>(
    search_target: &SearchTarget,
    timeout: Duration,
    ttl: Option<u32>,
    extra_keys: &'a [&'a str],
) -> Result<impl Stream<Item = Result<Device>> + 'a> {
    Ok(ssdp_client::search(search_target, timeout, 3, ttl)
        .await?
        .map_err(Error::SSDPError)
        .map(|res| Ok(res?.location().parse()?))
        .and_then(move |url| Device::from_url_and_properties(url, extra_keys)))
}
