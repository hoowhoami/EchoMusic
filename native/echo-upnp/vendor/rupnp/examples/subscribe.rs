use futures::prelude::*;
use rupnp::{http::Uri, ssdp::URN, Device};
use std::collections::HashMap;

#[tokio::main]
async fn main() -> Result<(), rupnp::Error> {
    let url = Uri::from_static("http://192.168.178.40:1400/xml/device_description.xml");
    let service_urn = URN::service("schemas-upnp-org", "ZoneGroupTopology", 1);

    let device = Device::from_url(url).await?;
    let service = device.find_service(&service_urn).unwrap();

    let (sid, mut stream) = service.subscribe(device.url(), 10).await?;

    while let Some(state_vars) = stream.try_next().await? {
        handle(state_vars);
        service.renew_subscription(device.url(), &sid, 10).await?;
    }

    Ok(())
}

fn handle(state_vars: HashMap<String, String>) {
    println!("Change {{");
    for (key, value) in state_vars {
        if value.len() > 256 {
            println!("  {key}: ...");
        } else {
            println!("  {key}: {value}");
        }
    }
    println!("}}");
}
