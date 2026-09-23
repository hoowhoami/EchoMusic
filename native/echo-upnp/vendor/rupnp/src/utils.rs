use crate::{Error, Result};
#[cfg(feature = "subscribe")]
use if_addrs::{get_if_addrs, Interface};
use roxmltree::{Document, Node};
#[cfg(feature = "subscribe")]
use std::net::{IpAddr, SocketAddrV4};

/// EchoMusic patch: maximum number of bytes accepted for any UPnP-fetched body
/// (device description, SCPD, SOAP responses, GENA). Prevents untrusted discovery
/// responses from exhausting memory.
pub const NETWORK_BODY_MAX_BYTES: usize = 4 * 1024 * 1024;

pub(crate) trait HttpResponseExt: Sized {
    fn err_if_not_200(self) -> Result<Self>;
}
impl<B> HttpResponseExt for hyper::Response<B> {
    fn err_if_not_200(self) -> Result<Self> {
        if self.status() != 200 {
            Err(Error::HttpErrorCode(self.status()))
        } else {
            Ok(self)
        }
    }
}
pub(crate) trait HyperBodyExt: Sized {
    async fn bytes(self) -> Result<bytes::Bytes>;
    async fn bytes_limited(self, max: usize) -> Result<bytes::Bytes>;
}
impl HyperBodyExt for hyper::body::Incoming {
    async fn bytes(self) -> Result<bytes::Bytes> {
        // EchoMusic patch: cap every body by default. Callers that need stricter
        // limits may use `bytes_limited`.
        self.bytes_limited(NETWORK_BODY_MAX_BYTES).await
    }
    async fn bytes_limited(self, max: usize) -> Result<bytes::Bytes> {
        use http_body_util::BodyExt;
        let mut collected = Vec::new();
        let mut body = self;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(crate::Error::NetworkError)?;
            if let Some(data) = frame.data_ref() {
                if collected.len().saturating_add(data.len()) > max {
                    return Err(Error::ResponseTooLarge(max));
                }
                collected.extend_from_slice(data);
            }
        }
        Ok(bytes::Bytes::from(collected))
    }
}

#[macro_export]
#[doc(hidden)]
macro_rules! find_in_xml {
    ( $node:expr => $( $($var:ident)? $(?$var_opt:ident)? ),+ $(#$var_hash_opt:ident)? ) => { {
        let node = $node;
        $(
            $(let mut $var = None;)?
            $(let mut $var_opt = None;)?
        )*
        $(
            let mut $var_hash_opt: HashMap<String, Option<String>> = $var_hash_opt
                .iter()
                .map(|k| (k.to_string(), None))
                .collect();
        )?
        for child in node.children().filter(roxmltree::Node::is_element) {
            match child.tag_name().name() {
                $(
                    $(stringify!($var) => $var = Some(child),)?
                    $(stringify!($var_opt) => $var_opt = Some(child),)?
                )*
                _ => (),
            }
            $(
                if $var_hash_opt.contains_key(child.tag_name().name()) {
                    $var_hash_opt.insert(
                        child.tag_name().name().to_string(),
                        $crate::utils::parse_node_text(child).ok());
                }
            )?
        }

        $($(
            let $var = $var.ok_or_else(|| $crate::Error::XmlMissingElement(
                node.tag_name().name().to_string(),
                stringify!($var).to_string(),
            ))?;
        )?)*

        (
            $(
                $($var)?
                $($var_opt)?
            ),*
            $( $var_hash_opt )?
        )
    } }
}

pub fn parse_node_text<T, E>(node: Node<'_, '_>) -> Result<T>
where
    T: std::str::FromStr<Err = E>,
    E: std::error::Error + Send + Sync + 'static,
{
    node.text()
        .unwrap_or_default()
        .parse()
        .map_err(Error::invalid_response)
}

pub fn find_root<'a, 'input: 'a>(
    document: &'input Document<'_>,
    element: &str,
    docname: &str,
) -> Result<Node<'a, 'input>> {
    document
        .descendants()
        .filter(Node::is_element)
        .find(|n| n.tag_name().name().eq_ignore_ascii_case(element))
        .ok_or_else(|| Error::XmlMissingElement(docname.to_string(), element.to_string()))
}

pub fn find_node_attribute<'n, 'd: 'n>(node: Node<'d, 'n>, attr: &str) -> Option<&'n str> {
    node.attributes()
        .find(|a| a.name().eq_ignore_ascii_case(attr))
        .map(|a| a.value())
}

#[cfg(feature = "subscribe")]
pub fn get_local_addr() -> Result<SocketAddrV4> {
    get_if_addrs()?
        .iter()
        .map(Interface::ip)
        .filter_map(|addr| match addr {
            IpAddr::V4(addr) => Some(addr),
            IpAddr::V6(_) => None,
        })
        .find(|x| x.is_private())
        .ok_or(Error::NoLocalInterfaceOpen)
        .map(|addr| SocketAddrV4::new(addr, 0))
}

#[cfg(test)]
mod tests {
    use crate::find_in_xml;
    use roxmltree::Document;
    use std::collections::HashMap;

    #[test]
    fn test_find_in_xml_macro() -> Result<(), Box<dyn std::error::Error>> {
        let xml = r#"
        <device>
            <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
            <friendlyName>My Media Server</friendlyName>
            <manufacturer>ACME Corp</manufacturer>
            <modelName>MediaBox 3000</modelName>
            <serviceList>
                <service>
                    <serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType>
                </service>
            </serviceList>
            <deviceList>
                <device>
                    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
                </device>
            </deviceList>
            <extraInfo>Some extra information</extraInfo>
        </device>
        "#;

        let doc = Document::parse(xml).unwrap();
        let device_node = doc.root_element();

        let extra_element_keys = &["extraInfo"];

        #[rustfmt::skip]
        #[allow(non_snake_case)]
        let (device_type, friendly_name, services, devices, extra_elements) = 
            find_in_xml! { device_node => deviceType, friendlyName, ?serviceList, ?deviceList, #extra_element_keys };

        // Test required elements
        assert_eq!(
            device_type.text(),
            Some("urn:schemas-upnp-org:device:MediaServer:1")
        );
        assert_eq!(friendly_name.text(), Some("My Media Server"));

        // Test optional elements
        assert!(services.is_some());
        assert!(devices.is_some());

        // Test extra elements
        let mut expected_extra = HashMap::new();
        expected_extra.insert(
            "extraInfo".to_string(),
            Some("Some extra information".to_string()),
        );
        assert_eq!(extra_elements, expected_extra);

        // Test non-existent optional element
        let extra_element_keys = &["nonExistentElement"];

        #[rustfmt::skip]
        #[allow(non_snake_case)]
        let (_, _, _, _, missing_extra) =
            find_in_xml! { device_node => deviceType, friendlyName, ?serviceList, ?deviceList, #extra_element_keys };

        let mut expected_missing = HashMap::new();
        expected_missing.insert("nonExistentElement".to_string(), None);
        assert_eq!(missing_extra, expected_missing);

        Ok(())
    }
}
