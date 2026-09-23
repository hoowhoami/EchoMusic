use crate::{
    find_in_xml,
    utils::{self, HttpResponseExt, HyperBodyExt},
    Result, Service,
};
use bytes::Bytes;
use http::Uri;
use http_body_util::Empty;
use hyper_util::rt::TokioExecutor;
use roxmltree::{Document, Node};
use ssdp_client::URN;
use std::collections::HashMap;
use std::hash::Hash;
use std::hash::Hasher;

#[derive(Debug, Clone)]
/// A UPnP Device.
/// It stores its [`Uri`] and a [`DeviceSpec`], which contains information like the device type and
/// its list of inner devices and services.
pub struct Device {
    url: Uri,
    device_spec: DeviceSpec,
}
impl Device {
    pub fn url(&self) -> &Uri {
        &self.url
    }

    /// Creates a UPnP device from the given url.
    /// The url should point to the `/device_description.xml` or similar of the device.
    /// If you dont know the concrete location, use [`discover`](fn.discover.html) instead.
    pub async fn from_url(url: Uri) -> Result<Self> {
        Self::from_url_and_properties(url, &[]).await
    }

    /// Creates a UPnP device from the given url, defining extra device properties
    /// to be accessed with `get_extra_property`.
    pub async fn from_url_and_properties(url: Uri, extra_keys: &[&str]) -> Result<Self> {
        let body = hyper_util::client::legacy::Client::builder(TokioExecutor::new())
            .build_http::<Empty<Bytes>>()
            .get(url.clone())
            .await?
            .err_if_not_200()?
            .into_body()
            // EchoMusic patch (research §5): cap untrusted device descriptions.
            .bytes_limited(crate::utils::NETWORK_BODY_MAX_BYTES)
            .await?;

        let body = std::str::from_utf8(&body)?;

        let document = Document::parse(body)?;
        let device = utils::find_root(&document, "device", "Device Description")?;
        let device_spec = DeviceSpec::from_xml(device, extra_keys)?;

        Ok(Self { url, device_spec })
    }
}
impl std::ops::Deref for Device {
    type Target = DeviceSpec;

    fn deref(&self) -> &Self::Target {
        &self.device_spec
    }
}
impl Hash for Device {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.url.hash(state);
    }
}
impl PartialEq for Device {
    fn eq(&self, other: &Self) -> bool {
        self.url == other.url
    }
}
impl Eq for Device {}

/// Information about a device.
///
/// By default it only includes its *friendly name*, device type, a list of subdevices and
/// services, and a `HashMap` of extra properties in order to keep the structs size small.
///
/// If you also want the `ManufacturerURL`, `Model{Description,Number,Url}`, `serial number`, `UDN` and
/// `UPC` as struct fields, enable the `full_device_spec` feature.
#[derive(Debug, Clone)]
pub struct DeviceSpec {
    device_type: URN,
    friendly_name: String,

    devices: Vec<DeviceSpec>,
    services: Vec<Service>,

    extra_properties: HashMap<String, Option<String>>,

    #[cfg(feature = "full_device_spec")]
    manufacturer: String,
    #[cfg(feature = "full_device_spec")]
    manufacturer_url: Option<String>,
    #[cfg(feature = "full_device_spec")]
    model_name: String,
    #[cfg(feature = "full_device_spec")]
    model_description: Option<String>,
    #[cfg(feature = "full_device_spec")]
    model_number: Option<String>,
    #[cfg(feature = "full_device_spec")]
    model_url: Option<String>,
    #[cfg(feature = "full_device_spec")]
    serial_number: Option<String>,
    #[cfg(feature = "full_device_spec")]
    udn: String,
    #[cfg(feature = "full_device_spec")]
    upc: Option<String>,
    #[cfg(feature = "full_device_spec")]
    presentation_url: Option<String>,
}

impl DeviceSpec {
    fn from_xml<'a, 'input: 'a>(node: Node<'a, 'input>, extra_keys: &[&str]) -> Result<Self> {
        #[rustfmt::skip]
        #[allow(non_snake_case)]
        let (device_type, friendly_name, services, devices, extra_properties) =
            find_in_xml! { node => deviceType, friendlyName, ?serviceList, ?deviceList, #extra_keys };

        #[cfg(feature = "full_device_spec")]
        #[allow(non_snake_case)]
        let (
            manufacturer,
            manufacturer_url,
            model_name,
            model_description,
            model_number,
            model_url,
            serial_number,
            udn,
            upc,
            presentation_url,
        ) = find_in_xml! { node => manufacturer, ?manufacturerURL, modelName, ?modelDescription, ?modelNumber, ?modelURL, ?serialNumber, UDN, ?UPC, ?PresentationURL};

        #[cfg(feature = "full_device_spec")]
        let manufacturer_url = manufacturer_url.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let model_description = model_description.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let model_number = model_number.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let model_url = model_url.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let serial_number = serial_number.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let upc = upc.map(utils::parse_node_text).transpose()?;
        #[cfg(feature = "full_device_spec")]
        let presentation_url = presentation_url.map(utils::parse_node_text).transpose()?;

        let devices = match devices {
            Some(d) => d
                .children()
                .filter(Node::is_element)
                .map(|node| DeviceSpec::from_xml(node, extra_keys))
                .collect::<Result<_>>()?,
            None => Vec::new(),
        };
        let services = match services {
            Some(s) => s
                .children()
                .filter(Node::is_element)
                .map(Service::from_xml)
                .collect::<Result<_>>()?,
            None => Vec::new(),
        };

        Ok(Self {
            device_type: utils::parse_node_text(device_type)?,
            friendly_name: utils::parse_node_text(friendly_name)?,
            #[cfg(feature = "full_device_spec")]
            manufacturer: utils::parse_node_text(manufacturer)?,
            #[cfg(feature = "full_device_spec")]
            udn: utils::parse_node_text(udn)?,
            #[cfg(feature = "full_device_spec")]
            manufacturer_url,
            #[cfg(feature = "full_device_spec")]
            model_name: utils::parse_node_text(model_name)?,
            #[cfg(feature = "full_device_spec")]
            model_description,
            #[cfg(feature = "full_device_spec")]
            model_number,
            #[cfg(feature = "full_device_spec")]
            model_url,
            #[cfg(feature = "full_device_spec")]
            serial_number,
            #[cfg(feature = "full_device_spec")]
            upc,
            #[cfg(feature = "full_device_spec")]
            presentation_url,
            devices,
            services,
            extra_properties,
        })
    }

    pub fn device_type(&self) -> &URN {
        &self.device_type
    }
    pub fn friendly_name(&self) -> &str {
        &self.friendly_name
    }
    pub fn get_extra_property(&self, elem: &str) -> Option<&str> {
        self.extra_properties
            .get(elem)
            .and_then(|o| o.as_ref())
            .map(String::as_str)
    }

    #[cfg(feature = "full_device_spec")]
    pub fn manufacturer(&self) -> &str {
        &self.manufacturer
    }
    #[cfg(feature = "full_device_spec")]
    pub fn manufacturer_url(&self) -> Option<&str> {
        self.manufacturer_url.as_ref().map(String::as_str)
    }
    #[cfg(feature = "full_device_spec")]
    pub fn model_name(&self) -> &str {
        &self.model_name
    }
    #[cfg(feature = "full_device_spec")]
    pub fn model_description(&self) -> Option<&str> {
        self.model_description.as_ref().map(String::as_str)
    }
    #[cfg(feature = "full_device_spec")]
    pub fn model_number(&self) -> Option<&str> {
        self.model_number.as_ref().map(String::as_str)
    }
    #[cfg(feature = "full_device_spec")]
    pub fn model_url(&self) -> Option<&str> {
        self.model_url.as_ref().map(String::as_str)
    }
    #[cfg(feature = "full_device_spec")]
    pub fn serial_number(&self) -> Option<&str> {
        self.serial_number.as_ref().map(String::as_str)
    }
    #[cfg(feature = "full_device_spec")]
    pub fn udn(&self) -> &str {
        &self.udn
    }
    #[cfg(feature = "full_device_spec")]
    pub fn upc(&self) -> Option<&str> {
        self.upc.as_ref().map(String::as_str)
    }

    /// Returns a list of this devices subdevices.
    /// Note that this does not recurse, if you want that behaviour use
    /// [devices_iter](struct.DeviceSpec.html#method.devices_iter) instead.
    pub fn devices(&self) -> &Vec<DeviceSpec> {
        &self.devices
    }

    /// Returns a list of this devices services.
    /// Note that this does not recurse, if you want that behaviour use
    /// [services_iter](struct.DeviceSpec.html#method.services_iter) instead.
    pub fn services(&self) -> &Vec<Service> {
        &self.services
    }

    /// Returns an Iterator of all services that can be used from this device.
    pub fn services_iter(&self) -> impl Iterator<Item = &Service> {
        self.services().iter().chain(self.devices().iter().flat_map(
            |device| -> Box<dyn Iterator<Item = &Service>> { Box::new(device.services_iter()) },
        ))
    }
    pub fn find_service(&self, service_type: &URN) -> Option<&Service> {
        self.services_iter()
            .find(|s| s.service_type() == service_type)
    }

    /// Returns an Iterator of all devices that can be used from this device.
    pub fn devices_iter(&self) -> impl Iterator<Item = &DeviceSpec> {
        self.devices().iter().chain(self.devices().iter().flat_map(
            |device| -> Box<dyn Iterator<Item = &DeviceSpec>> { Box::new(device.devices_iter()) },
        ))
    }
    pub fn find_device(&self, device_type: &URN) -> Option<&DeviceSpec> {
        self.devices_iter().find(|d| &d.device_type == device_type)
    }
}
