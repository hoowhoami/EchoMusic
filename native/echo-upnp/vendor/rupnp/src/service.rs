use crate::{
    error::{Error, UPnPError},
    find_in_xml,
    scpd::SCPD,
    utils::{self, HttpResponseExt},
    Result,
};

use bytes::Bytes;
#[cfg(feature = "subscribe")]
use futures_core::stream::Stream;
#[cfg(feature = "subscribe")]
use genawaiter::sync::{Co, Gen};
use http_body_util::Empty;
use hyper_util::{client::legacy::Client, rt::TokioExecutor};
#[cfg(feature = "subscribe")]
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

use http::{Request, Uri};
use roxmltree::{Document, Node};
use ssdp_client::URN;

use std::collections::HashMap;
use utils::HyperBodyExt;

/// A UPnP Service is the description of endpoints on a device for performing actions and reading
/// the service definition.
/// For a list of actions and state variables the service provides, take a look at [`scpd`](struct.Service.html#method.scpd).
#[derive(Debug, Clone)]
pub struct Service {
    service_type: URN,
    service_id: String,
    // EchoMusic patch: kept as raw text instead of `PathAndQuery`. Devices in
    // the wild ship `<SCPDURL>AVTransport1.xml</SCPDURL>` without a leading slash,
    // which `PathAndQuery` rejects outright ("path does not start with slash").
    // Parsing them eagerly made one sloppy service sink the whole device load.
    scpd_endpoint: String,
    control_endpoint: String,
    event_sub_endpoint: String,
}

impl Service {
    pub(crate) fn from_xml(node: Node<'_, '_>) -> Result<Self> {
        #[allow(non_snake_case)]
        let (service_type, service_id, scpd_endpoint, control_endpoint, event_sub_endpoint) =
            find_in_xml! { node => serviceType, serviceId, SCPDURL, controlURL, eventSubURL };

        Ok(Self {
            service_type: utils::parse_node_text(service_type)?,
            service_id: utils::parse_node_text(service_id)?,
            scpd_endpoint: node_endpoint_text(scpd_endpoint),
            control_endpoint: node_endpoint_text(control_endpoint),
            event_sub_endpoint: node_endpoint_text(event_sub_endpoint),
        })
    }

    /// Returns the [URN](ssdp_client::URN) of this service.
    pub fn service_type(&self) -> &URN {
        &self.service_type
    }

    /// Returns the `Service Identifier`.
    pub fn service_id(&self) -> &str {
        &self.service_id
    }

    /// URL for this service's control endpoint, resolved against the device URL.
    /// (EchoMusic patch: made `pub` so wrapper addons can expose absolute URLs.)
    pub fn control_url(&self, url: &Uri) -> Result<Uri> {
        resolve_endpoint(url, &self.control_endpoint)
    }
    pub fn scpd_url(&self, url: &Uri) -> Result<Uri> {
        resolve_endpoint(url, &self.scpd_endpoint)
    }
    pub fn event_sub_url(&self, url: &Uri) -> Result<Uri> {
        resolve_endpoint(url, &self.event_sub_endpoint)
    }

    /// Fetches the [`SCPD`](scpd/struct.SCPD.html) of this service.
    pub async fn scpd(&self, url: &Uri) -> Result<SCPD> {
        SCPD::from_url(&self.scpd_url(url)?, self.service_type().clone()).await
    }

    /// Execute some UPnP Action on this service.
    /// The URL is usually obtained by the device this service was found on.
    /// The payload is xml-formatted data.
    ///
    /// # Example usage:
    ///
    /// ```rust,no_run
    /// # use ssdp_client::URN;
    /// # async fn rendering_control_example() -> Result<(), rupnp::Error> {
    /// # let some_url = unimplemented!();
    /// use rupnp::ssdp::URN;
    /// use rupnp::Device;
    ///
    /// let urn = URN::service("schemas-upnp-org", "RenderingControl", 1);
    ///
    /// let device = Device::from_url( some_url ).await?;
    /// let service = device.find_service(&urn)
    ///     .expect("service exists");
    ///
    /// let args = "<InstanceID>0</InstanceID><Channel>Master</Channel>";
    /// let response = service.action(device.url(), "GetVolume", args).await?;
    ///
    /// let volume = response
    ///     .get("CurrentVolume")
    ///     .expect("exists");
    ///
    /// println!("Volume: {}", volume);
    /// # Ok(())
    /// # }
    /// ```
    pub async fn action(
        &self,
        url: &Uri,
        action: &str,
        payload: &str,
    ) -> Result<HashMap<String, String>> {
        let body = format!(
            r#"
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
                s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
                <s:Body>
                    <u:{action} xmlns:u="{service}">
                        {payload}
                    </u:{action}>
                </s:Body>
            </s:Envelope>"#,
            service = &self.service_type,
            action = action,
            payload = payload
        );

        let soap_action = format!("\"{}#{}\"", &self.service_type, action);

        let request = Request::post(self.control_url(url)?)
            .header("CONTENT-TYPE", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", soap_action)
            .body(body)
            .expect("infallible");
        let doc = Client::builder(TokioExecutor::new())
            .build_http()
            .request(request)
            .await?
            .err_if_not_200()?
            .into_body()
            .bytes()
            .await?;
        let doc = std::str::from_utf8(&doc)?;

        let document = Document::parse(doc)?;
        let response = utils::find_root(&document, "Body", "UPnP Response")?
            .first_element_child()
            .ok_or_else(|| {
                Error::XmlMissingElement("Body".to_string(), format!("{action}Response"))
            })?;

        if response.tag_name().name().eq_ignore_ascii_case("Fault") {
            return Err(UPnPError::from_fault_node(response)?.into());
        }

        let values: HashMap<_, _> = response
            .children()
            .filter(Node::is_element)
            .filter_map(|node| -> Option<(String, String)> {
                node.text()
                    .map(|text| (node.tag_name().name().to_string(), text.to_string()))
            })
            .collect();

        Ok(values)
    }

    #[cfg(feature = "subscribe")]
    async fn make_subscribe_request(
        &self,
        url: &Uri,
        callback: &str,
        timeout_secs: u32,
    ) -> Result<String> {
        use bytes::Bytes;
        use http_body_util::Empty;

        let req = Request::builder()
            .uri(self.event_sub_url(url)?)
            .method("SUBSCRIBE")
            .header("CALLBACK", format!("<{callback}>"))
            .header("NT", "upnp:event")
            .header("TIMEOUT", format!("Second-{timeout_secs}"))
            .body(Empty::<Bytes>::new())
            .expect("infallible");

        let response = Client::builder(TokioExecutor::new())
            .build_http()
            .request(req)
            .await?
            .err_if_not_200()?;

        let sid = response
            .headers()
            .get("sid")
            .ok_or_else(|| Error::ParseError("missing http header `SID`"))?
            .to_str()
            .map_err(|_| Error::ParseError("SID header contained non-visible ASCII bytes"))?
            .to_string();

        Ok(sid)
    }

    /// Subscribe for state variable changes.
    ///
    /// It returns the SID which can be used to unsubscribe to the service and a stream of
    /// responses.
    ///
    /// Each response is a [HashMap](std::collections::HashMap) of the state variables.
    ///
    /// # Example usage:
    /// ```rust,no_run
    /// # use futures::prelude::*;
    /// # async fn subscribe_example() -> Result<(), rupnp::Error> {
    /// # let device: rupnp::Device = unimplemented!();
    /// # let service: rupnp::Service = unimplemented!();
    /// let (_sid, stream) = service.subscribe(device.url(), 300).await?;
    ///
    /// while let Some(state_vars) = stream.try_next().await? {
    ///     for (key, value) in state_vars {
    ///         println!("{} => {}", key, value);
    ///     }
    /// }
    /// # Ok(())
    /// # }
    /// ```
    #[cfg(feature = "subscribe")]
    pub async fn subscribe(
        &self,
        url: &Uri,
        timeout_secs: u32,
    ) -> Result<(String, impl Stream<Item = Result<HashMap<String, String>>>)> {
        let addr = utils::get_local_addr()?;
        let listener = TcpListener::bind(addr).await?;

        let addr = format!("http://{}", listener.local_addr()?);

        let sid = self
            .make_subscribe_request(url, &addr, timeout_secs)
            .await?;

        let stream = Gen::new(move |co: Co<Result<_>>| subscribe_stream(listener, co));

        Ok((sid, stream))
    }

    /// Renew a subscription made with the [subscribe](struct.Service.html#method.subscribe) method.
    ///
    /// When the sid is invalid, the control point will respond with a `412 Preconditition failed`.
    pub async fn renew_subscription(&self, url: &Uri, sid: &str, timeout_secs: u32) -> Result<()> {
        let req = Request::builder()
            .uri(self.event_sub_url(url)?)
            .method("SUBSCRIBE")
            .header("SID", sid)
            .header("TIMEOUT", format!("Second-{timeout_secs}"))
            .body(Empty::<Bytes>::new())
            .expect("infallible");
        Client::builder(TokioExecutor::new())
            .build_http()
            .request(req)
            .await?
            .err_if_not_200()?;

        Ok(())
    }

    /// Unsubscribe from further event notifications.
    ///
    /// The SID is usually obtained by the [subscribe](struct.Service.html#method.subscribe) method.
    ///
    /// When the sid is invalid, the control point will respond with a `412 Preconditition failed`.
    pub async fn unsubscribe(&self, url: &Uri, sid: &str) -> Result<()> {
        let req = Request::builder()
            .uri(self.event_sub_url(url)?)
            .method("UNSUBSCRIBE")
            .header("SID", sid)
            .body(Empty::<Bytes>::new())
            .expect("infallible");

        Client::builder(TokioExecutor::new())
            .build_http()
            .request(req)
            .await?
            .err_if_not_200()?;

        Ok(())
    }
}

#[cfg(feature = "subscribe")]
macro_rules! yield_try {
    ( $co:expr => $expr:expr ) => {
        match $expr {
            Ok(val) => val,
            Err(e) => {
                $co.yield_(Err(e.into())).await;
                continue;
            }
        }
    };
}

#[cfg(feature = "subscribe")]
fn propertyset_to_map(input: &str) -> Result<HashMap<String, String>, roxmltree::Error> {
    let doc = Document::parse(input)?;
    let hashmap: HashMap<String, String> = doc
        .root_element() // <e:propertyset />
        .children() // <e:property />
        .filter_map(|child| child.first_element_child()) // actual tag
        .filter_map(|node| {
            node.text()
                .map(|text| (node.tag_name().name().to_string(), text.to_string()))
        })
        .collect();

    Ok(hashmap)
}

#[cfg(feature = "subscribe")]
async fn subscribe_stream(listener: TcpListener, co: Co<Result<HashMap<String, String>>>) {
    loop {
        let (mut stream, _) = yield_try!(co => listener.accept().await);
        let mut lines = BufReader::new(&mut stream).lines();

        let mut input = String::new();
        let mut is_xml = false;

        // sometimes the xml is on one line, sometimes on multiple ones.
        // we dont care about the http stuff before the "<e:propertyset>"
        while let Ok(Some(line)) = lines.next_line().await {
            if is_xml || line.starts_with("<e:propertyset") {
                input.push_str(&line);
                is_xml = true;
            }

            if line.ends_with("</e:propertyset>") {
                break;
            };
        }

        let response = "HTTP/1.1 200 OK\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;

        let hashmap = yield_try!(co => propertyset_to_map(&input));

        co.yield_(Ok(hashmap)).await;
    }
}

/// EchoMusic patch: read a service endpoint element as trimmed text.
///
/// Devices commonly ship relative endpoints without a leading slash
/// (`<SCPDURL>AVTransport1.xml</SCPDURL>`) or with stray whitespace from
/// pretty-printed XML. Keeping the raw text defers all URL handling to
/// [`resolve_endpoint`], so a malformed endpoint can no longer fail the whole
/// device description parse.
fn node_endpoint_text(node: Node<'_, '_>) -> String {
    node.text().unwrap_or_default().trim().to_string()
}

/// EchoMusic patch: resolve a service endpoint against the device description URL.
///
/// Per UPnP Device Architecture the endpoints may be absolute, root-relative or
/// relative to the description document. The previous `PathAndQuery` parse only
/// accepted root-relative paths and rejected the rest, which is what made devices
/// such as the Xiaomi speaker (relative `<SCPDURL>AVTransport1.xml</SCPDURL>`)
/// unloadable. `http::Uri` has no RFC 3986 `join`, so resolve by hand.
fn resolve_endpoint(base: &Uri, endpoint: &str) -> Result<Uri> {
    let endpoint = endpoint.trim();
    if endpoint.is_empty() {
        return Err(Error::XmlMissingElement(
            "service".to_string(),
            "endpoint URL is empty".to_string(),
        ));
    }

    // Already absolute: keep scheme/authority, but reject a host that disagrees
    // with the description URL so a device cannot redirect control traffic off-host.
    if let Ok(absolute) = endpoint.parse::<Uri>() {
        if absolute.scheme().is_some() && absolute.authority().is_some() {
            let base_authority = base.authority().map(|a| a.as_str());
            let same_host = absolute.authority().map(|a| a.as_str()) == base_authority;
            if !same_host {
                return Err(invalid_endpoint(format!(
                    "service endpoint host {:?} does not match the device description host {:?}",
                    absolute.authority().map(|a| a.as_str()),
                    base_authority
                )));
            }
            return Ok(absolute);
        }
    }

    let parts = base.clone().into_parts();
    let path = match endpoint.strip_prefix('/') {
        // Root-relative: replaces the whole base path.
        Some(rest) => rest,
        // Document-relative: replace the last path segment of the description URL.
        None => {
            let base_path = base.path();
            let directory = match base_path.rfind('/') {
                Some(index) => &base_path[..index + 1],
                None => "/",
            };
            return resolve_parts(parts, &format!("{directory}{endpoint}"));
        }
    };
    resolve_parts(parts, path)
}

fn resolve_parts(mut parts: http::uri::Parts, path: &str) -> Result<Uri> {
    // A relative endpoint may still carry a query (`control?x=1`); split it off
    // so `PathAndQuery` gets a valid reference.
    let (path, query) = match path.find('?') {
        Some(index) => (&path[..index], Some(&path[index + 1..])),
        None => (path, None),
    };
    let mut reference = path.to_string();
    if !reference.starts_with('/') {
        reference.insert(0, '/');
    }
    if let Some(query) = query {
        reference.push('?');
        reference.push_str(query);
    }
    parts.path_and_query = Some(
        reference
            .parse::<http::uri::PathAndQuery>()
            .map_err(|e| invalid_endpoint(format!("invalid service endpoint {reference:?}: {e}")))?,
    );
    Uri::from_parts(parts)
        .map_err(|_| invalid_endpoint(format!("service endpoint {reference:?} is not a valid URI")))
}

/// EchoMusic patch: a plain message carrier for endpoint rejections.
///
/// `http::uri::InvalidUri` cannot be constructed directly in http 1.x, so these
/// rejections need their own `std::error::Error` to travel through
/// [`Error::InvalidResponse`] without losing their explanation.
#[derive(Debug)]
struct InvalidEndpoint(String);

impl std::fmt::Display for InvalidEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InvalidEndpoint {}

/// EchoMusic patch: build an [`Error::InvalidResponse`] from a formatted message.
fn invalid_endpoint(message: String) -> Error {
    Error::InvalidResponse(Box::new(InvalidEndpoint(message)))
}

#[cfg(test)]
mod endpoint_tests {
    use super::resolve_endpoint;

    fn uri(raw: &str) -> http::Uri {
        raw.parse().unwrap()
    }

    #[test]
    fn resolves_absolute_endpoint_on_same_host() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        let resolved = resolve_endpoint(&base, "http://192.168.6.184:9999/AVTransport/control").unwrap();
        assert_eq!(resolved, uri("http://192.168.6.184:9999/AVTransport/control"));
    }

    #[test]
    fn rejects_endpoint_on_other_host() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        assert!(resolve_endpoint(&base, "http://evil.test/control").is_err());
    }

    #[test]
    fn resolves_root_relative_endpoint() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        let resolved = resolve_endpoint(&base, "/AVTransport/control").unwrap();
        assert_eq!(resolved, uri("http://192.168.6.184:9999/AVTransport/control"));
    }

    // The Xiaomi speaker ships every endpoint document-relative with no slash.
    #[test]
    fn resolves_document_relative_endpoint_without_leading_slash() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        assert_eq!(
            resolve_endpoint(&base, "AVTransport1.xml").unwrap(),
            uri("http://192.168.6.184:9999/AVTransport1.xml")
        );
        assert_eq!(
            resolve_endpoint(&base, "Queue1/control").unwrap(),
            uri("http://192.168.6.184:9999/Queue1/control")
        );
    }

    #[test]
    fn resolves_document_relative_endpoint_from_nested_description_url() {
        let base = uri("http://192.168.6.184:9999/dev/6abf92a9.xml");
        assert_eq!(
            resolve_endpoint(&base, "Queue1/control").unwrap(),
            uri("http://192.168.6.184:9999/dev/Queue1/control")
        );
    }

    #[test]
    fn keeps_query_string() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        assert_eq!(
            resolve_endpoint(&base, "control?device=0").unwrap(),
            uri("http://192.168.6.184:9999/control?device=0")
        );
    }

    #[test]
    fn rejects_empty_endpoint() {
        let base = uri("http://192.168.6.184:9999/6abf92a9.xml");
        assert!(resolve_endpoint(&base, "   ").is_err());
    }

    #[test]
    fn resolves_against_description_url_without_path() {
        let base = uri("http://192.168.6.184:9999");
        assert_eq!(
            resolve_endpoint(&base, "AVTransport1.xml").unwrap(),
            uri("http://192.168.6.184:9999/AVTransport1.xml")
        );
    }
}
