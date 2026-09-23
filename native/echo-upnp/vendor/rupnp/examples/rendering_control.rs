use rupnp::{http::Uri, ssdp::URN, Device};

#[tokio::main]
async fn main() -> Result<(), rupnp::Error> {
    let url = Uri::from_static("http://192.168.178.40:1400/xml/device_description.xml");
    let service_urn = URN::service("schemas-upnp-org", "RenderingControl", 1);

    let device = Device::from_url(url).await?;
    let service = device.find_service(&service_urn).unwrap();

    let args = "<InstanceID>0</InstanceID><Channel>Master</Channel>";
    let response: u8 = service
        .action(device.url(), "GetVolume", args)
        .await?
        .get("CurrentVolume")
        .unwrap()
        .parse()
        .map_err(rupnp::Error::invalid_response)?;

    println!("{response}");

    Ok(())
}
