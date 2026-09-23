use crate::find_in_xml;
use std::{fmt, str::Utf8Error};

/// The UPnP Error type.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    UPnPError(UPnPError),
    SSDPError(ssdp_client::Error),
    NetworkError(hyper::Error),
    NetworkClientError(hyper_util::client::legacy::Error),
    NoLocalInterfaceOpen,
    IO(std::io::Error),
    InvalidUrl(http::uri::InvalidUri),
    InvalidUtf8(Utf8Error),
    ParseError(&'static str),
    HttpErrorCode(http::StatusCode),
    XmlError(roxmltree::Error),
    XmlMissingElement(String, String),
    InvalidResponse(Box<dyn std::error::Error + Send + Sync + 'static>),
    /// EchoMusic patch: a network response body exceeded the configured size cap.
    ResponseTooLarge(usize),
}
impl Error {
    pub fn invalid_response<E: std::error::Error + Send + Sync + 'static>(err: E) -> Error {
        Error::InvalidResponse(Box::new(err))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::UPnPError(err) => write!(f, "{err}"),
            Error::SSDPError(err) => write!(f, "error trying to discover devices: {err}"),
            Error::IO(err) => write!(f, "error reading response: {err}"),
            Error::NetworkError(err) => {
                write!(f, "An error occurred trying to connect to device: {err}")
            }
            Error::NetworkClientError(err) => {
                write!(f, "An error occurred trying to connect to device: {err}")
            }
            Error::NoLocalInterfaceOpen => write!(
                f,
                "could not subscribe to events: no local ipv4 interface open"
            ),
            Error::InvalidUrl(err) => write!(f, "invalid url: {err}"),
            Error::InvalidUtf8(err) => write!(f, "invalid utf8: {err}"),
            Error::ParseError(err) => write!(f, "{err}"),
            Error::InvalidResponse(err) => write!(f, "Invalid response: {err}"),
            Error::HttpErrorCode(code) => {
                write!(f, "The control point responded with status code {code}")
            }
            Error::XmlError(err) => write!(f, "failed to parse xml: {err}"),
            Error::ResponseTooLarge(max) => {
                write!(f, "response body exceeded the {max} bytes safety cap")
            }
            Error::XmlMissingElement(parent, child) => write!(
                f,
                "`{parent}` does not contain a `{child}` element or attribute"
            ),
        }
    }
}
impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::UPnPError(err) => Some(err),
            Error::SSDPError(err) => Some(err),
            Error::NetworkError(err) => Some(err),
            Error::IO(err) => Some(err),
            Error::InvalidUrl(err) => Some(err),
            Error::InvalidUtf8(err) => Some(err),
            Error::XmlError(err) => Some(err),
            Error::ResponseTooLarge(_) => None,
            _ => None,
        }
    }
}
impl From<hyper::Error> for Error {
    fn from(err: hyper::Error) -> Self {
        Error::NetworkError(err)
    }
}
impl From<hyper_util::client::legacy::Error> for Error {
    fn from(err: hyper_util::client::legacy::Error) -> Self {
        Error::NetworkClientError(err)
    }
}
impl From<roxmltree::Error> for Error {
    fn from(err: roxmltree::Error) -> Self {
        Error::XmlError(err)
    }
}
impl From<std::io::Error> for Error {
    fn from(err: std::io::Error) -> Self {
        Error::IO(err)
    }
}
impl From<http::uri::InvalidUri> for Error {
    fn from(err: http::uri::InvalidUri) -> Self {
        Error::InvalidUrl(err)
    }
}
impl From<ssdp_client::Error> for Error {
    fn from(err: ssdp_client::Error) -> Self {
        Error::SSDPError(err)
    }
}
impl From<UPnPError> for Error {
    fn from(err: UPnPError) -> Self {
        Error::UPnPError(err)
    }
}
impl From<Utf8Error> for Error {
    fn from(err: Utf8Error) -> Self {
        Error::InvalidUtf8(err)
    }
}

#[derive(Debug)]
pub struct UPnPError {
    #[allow(unused)]
    fault_code: String,
    fault_string: String,
    err_code: u16,
}

impl std::error::Error for UPnPError {}
impl fmt::Display for UPnPError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {}",
            self.fault_string,
            self.err_code,
            self.err_code_description()
        )
    }
}

impl UPnPError {
    pub fn err_code(&self) -> u16 {
        self.err_code
    }

    pub fn err_code_description(&self) -> &str {
        match self.err_code {
            401 => "No action by that name at this service.",
            402 => "Invalid Arguments",
            403 => "(deprecated error code)",
            501 => "Action failed",
            600 => "Argument value invalid",
            601 => "Argument Value Out of Range",
            602 => "Optional Action Not Implemented",
            603 => "Out of Memory",
            604 => "Human Intervention Required",
            605 => "String Argument Too Long",
            606..=612 => "(error code reserved for UPnP DeviceSecurity)",
            613..=699 => "Common action error. Defined by UPnP Forum Technical Committee.",
            700..=799 => "Action-specific error defined by UPnP Forum working committee.",
            800..=899 => "Action-specific error for non-standard actions. Defined by UPnP vendor.",
            _ => "Invalid Error Code",
        }
    }

    pub(crate) fn from_fault_node(node: roxmltree::Node<'_, '_>) -> Result<UPnPError, Error> {
        let (fault_code, fault_string, detail) =
            find_in_xml! { node => faultcode, faultstring, detail };
        let fault_code = fault_code.text().unwrap_or_default().to_string();
        let fault_string = fault_string.text().unwrap_or_default().to_string();
        let err_code = detail
            .descendants()
            .find(|n| n.tag_name().name().eq_ignore_ascii_case("errorCode"))
            .ok_or_else(|| Error::XmlMissingElement("detail".to_string(), "errorCode".to_string()))?
            .text()
            .unwrap_or_default()
            .parse()
            .map_err(Error::invalid_response)?;

        Ok(UPnPError {
            fault_code,
            fault_string,
            err_code,
        })
    }
}
