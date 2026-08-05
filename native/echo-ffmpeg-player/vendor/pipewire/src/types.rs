use std::fmt;

// Macro generating the ObjectType enum
macro_rules! object_type {
    ($( ($x:ident, $version:ident) ),*) => {
        #[derive(Debug, Eq, PartialEq, Clone)]
        pub enum ObjectType {
            $($x,)*
            Other(String),
        }

        impl ObjectType {
            pub(crate) fn from_str(s: &str) -> ObjectType {
                match s {
                    $(
                    concat!("PipeWire:Interface:", stringify!($x)) => ObjectType::$x,
                    )*
                    s => ObjectType::Other(s.to_string()),
                }
            }

            pub fn to_str(&self) -> &str {
                match self {
                    $(
                        ObjectType::$x => concat!("PipeWire:Interface:", stringify!($x)),
                    )*
                    ObjectType::Other(s) => s,
                }
            }

            pub(crate) fn client_version(&self) -> u32 {
                match self {
                    $(
                        ObjectType::$x => $crate::sys::$version,
                    )*
                    ObjectType::Other(_) => panic!("Invalid object type"),
                }
            }
        }

        impl fmt::Display for ObjectType {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.to_str())
            }
        }
    };
}

object_type![
    // Id, API version
    (Client, PW_VERSION_CLIENT),
    (ClientEndpoint, PW_VERSION_CLIENT_ENDPOINT),
    (ClientNode, PW_VERSION_CLIENT_NODE),
    (ClientSession, PW_VERSION_CLIENT_SESSION),
    (Core, PW_VERSION_CORE),
    (Device, PW_VERSION_DEVICE),
    (Endpoint, PW_VERSION_ENDPOINT),
    (EndpointLink, PW_VERSION_ENDPOINT_LINK),
    (EndpointStream, PW_VERSION_ENDPOINT_STREAM),
    (Factory, PW_VERSION_FACTORY),
    (Link, PW_VERSION_LINK),
    (Metadata, PW_VERSION_METADATA),
    (Module, PW_VERSION_MODULE),
    (Node, PW_VERSION_NODE),
    (Port, PW_VERSION_PORT),
    (Profiler, PW_VERSION_PROFILER),
    (Registry, PW_VERSION_REGISTRY),
    (Session, PW_VERSION_SESSION)
];
