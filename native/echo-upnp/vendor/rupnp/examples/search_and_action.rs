use futures::prelude::*;
use rupnp::ssdp::{SearchTarget, URN};
use std::time::Duration;

const RENDERING_CONTROL: URN = URN::service("schemas-upnp-org", "RenderingControl", 1);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let search_target = SearchTarget::URN(RENDERING_CONTROL);
    let devices = rupnp::discover(&search_target, Duration::from_secs(3), None).await?;
    let mut devices = std::pin::pin!(devices);

    while let Some(device) = devices.try_next().await? {
        let service = device
            .find_service(&RENDERING_CONTROL)
            .expect("searched for RenderingControl, got something else");

        let args = "<InstanceID>0</InstanceID><Channel>Master</Channel>";
        let response = service.action(device.url(), "GetVolume", args).await?;

        let volume = response.get("CurrentVolume").unwrap();

        println!("'{}' is at volume {}", device.friendly_name(), volume);
    }

    Ok(())
}
