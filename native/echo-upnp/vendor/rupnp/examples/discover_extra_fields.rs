use futures::prelude::*;
use rupnp::ssdp::SearchTarget;
use std::time::Duration;

const EXTRA: &[&str; 2] = &["manufacturer", "manufacturerURL"];

#[tokio::main]
async fn main() -> Result<(), rupnp::Error> {
    let devices = rupnp::discover_with_properties(
        &SearchTarget::RootDevice,
        Duration::from_secs(3),
        None,
        EXTRA,
    )
    .await?;
    let mut devices = std::pin::pin!(devices);

    while let Some(maybe_device) = devices.next().await {
        if let Ok(device) = maybe_device { println!(
            "{} from {} @ {}",
            device.friendly_name(),
            device.get_extra_property(EXTRA[0]).unwrap_or_default(),
            device.get_extra_property(EXTRA[1]).unwrap_or_default()
        ) };
    }

    Ok(())
}
