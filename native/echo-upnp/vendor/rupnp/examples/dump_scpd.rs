use futures::prelude::*;
use rupnp::{
    http::Uri,
    ssdp::{SearchTarget, URN},
    DeviceSpec, Error, Service,
};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::task::{spawn, JoinHandle};

#[tokio::main]
async fn main() -> Result<(), Error> {
    let mut devices: Vec<_> =
        rupnp::discover(&SearchTarget::RootDevice, Duration::from_secs(1), None)
            .await?
            .filter_map(|result| async { result.map_err(|e| println!("{e}")).ok() })
            .collect()
            .await;

    devices.sort_by_key(|d| d.device_type().clone());
    devices.dedup_by_key(|d| d.device_type().clone());

    let path = PathBuf::from("descriptions");
    if path.exists() {
        fs::remove_dir_all(&path)?;
    }

    let mut handles = Vec::new();

    for device in devices {
        print(&device, device.url(), 0, &path, &mut handles)?;
        println!();
    }

    for handle in handles {
        handle.await.unwrap()?;
    }

    Ok(())
}

fn print(
    device: &DeviceSpec,
    url: &Uri,
    indentation: usize,
    path: &Path,
    handles: &mut Vec<JoinHandle<Result<(), rupnp::Error>>>,
) -> Result<(), Error> {
    let path = path.join(urn_to_str(device.device_type()));
    fs::create_dir_all(&path)?;

    let i = "  ".repeat(indentation);

    println!("{}{}", i, urn_to_str(device.device_type()));

    for service in device.services() {
        let svc = urn_to_str(service.service_type());

        println!("{i}  - {svc}");

        let url = url.clone();
        let path = path.clone();
        let service = service.clone();

        handles.push(spawn(async move {
            use std::io::Write;

            // let mut svc_file = tokio::fs::File::create(path.join(&svc)).await?;
            let mut svc_file = std::fs::File::create(path.join(&svc))?;

            let mut buf = Vec::with_capacity(128);
            write_service(&mut buf, service, url).await?;

            svc_file.write_all(&buf)?;
            // svc_file.write_all(&buf).await?;
            Ok(())
        }));
    }

    for device in device.devices() {
        print(device, url, indentation + 1, &path, handles)?;
    }

    Ok(())
}

async fn write_service(
    mut w: impl std::io::Write,
    service: Service,
    url: Uri,
) -> Result<(), Error> {
    let scpd = service.scpd(&url).await?;

    writeln!(w, "StateVars {{")?;
    for state_var in scpd.state_variables() {
        if state_var.sends_events() {
            writeln!(w, "  {state_var} (sends events)")?;
        } else {
            writeln!(w, "  {state_var}")?;
        }
    }
    writeln!(w, "}}\n\nActions {{")?;
    for action in scpd.actions() {
        writeln!(w, "  {action}")?;
    }
    writeln!(w, "}}")?;

    Ok(())
}

fn urn_to_str(urn: &URN) -> String {
    urn.typ().to_string().to_lowercase()
}
