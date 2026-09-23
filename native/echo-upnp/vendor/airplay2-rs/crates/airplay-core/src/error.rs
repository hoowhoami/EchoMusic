//! Error types for the AirPlay 2 sender.

use thiserror::Error;

/// Primary error type for all AirPlay operations.
#[derive(Error, Debug)]
pub enum Error {
    #[error("Discovery error: {0}")]
    Discovery(#[from] DiscoveryError),

    #[error("Connection error: {0}")]
    Connection(#[from] std::io::Error),

    #[error("Pairing error: {0}")]
    Pairing(#[from] PairingError),

    #[error("RTSP error: {0}")]
    Rtsp(#[from] RtspError),

    #[error("Streaming error: {0}")]
    Streaming(#[from] StreamingError),

    #[error("Crypto error: {0}")]
    Crypto(#[from] CryptoError),

    #[error("Parse error: {0}")]
    Parse(#[from] ParseError),

    #[error("Device does not support required feature: {feature}")]
    UnsupportedFeature { feature: &'static str },

    #[error("Device requires MFi authentication (not implementable without Apple hardware)")]
    MfiRequired,

    #[error("Operation timed out")]
    Timeout,
}

/// Errors during mDNS service discovery.
#[derive(Error, Debug)]
pub enum DiscoveryError {
    #[error("mDNS daemon error: {0}")]
    Daemon(String),

    #[error("Service resolution failed: {0}")]
    Resolution(String),

    #[error("No devices found")]
    NoDevicesFound,

    #[error("Device not found: {0}")]
    DeviceNotFound(String),
}

/// Errors during HomeKit/FairPlay pairing.
#[derive(Error, Debug)]
pub enum PairingError {
    #[error("Invalid PIN")]
    InvalidPin,

    #[error("Pairing rejected by device")]
    Rejected,

    #[error("SRP verification failed")]
    SrpVerificationFailed,

    #[error("Invalid server public key")]
    InvalidServerPublicKey,

    #[error("Signature verification failed")]
    SignatureInvalid,

    #[error("FairPlay setup failed: {0}")]
    FairPlayFailed(String),

    #[error("Pairing state mismatch: expected {expected}, got {actual}")]
    StateMismatch { expected: u8, actual: u8 },

    #[error("TLV parsing error: {0}")]
    TlvParse(String),

    #[error("Missing required TLV type: {0}")]
    MissingTlv(u8),

    #[error("Invalid pairing state: {0}")]
    InvalidState(String),

    #[error("Protocol error: {0}")]
    Protocol(String),
}

/// Errors during RTSP communication.
#[derive(Error, Debug)]
pub enum RtspError {
    #[error("Connection refused")]
    ConnectionRefused,

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Unexpected status code: {0}")]
    UnexpectedStatus(u16),

    #[error("Missing required header: {0}")]
    MissingHeader(String),

    #[error("Plist serialization error: {0}")]
    PlistError(String),

    #[error("Session not established")]
    NoSession,

    #[error("Setup failed: {0}")]
    SetupFailed(String),
}

/// Errors during audio streaming.
#[derive(Error, Debug)]
pub enum StreamingError {
    #[error("Encoding error: {0}")]
    Encoding(String),

    #[error("Buffer underrun")]
    BufferUnderrun,

    #[error("Buffer overflow")]
    BufferOverflow,

    #[error("Timing sync lost")]
    TimingSyncLost,

    #[error("Stream interrupted")]
    Interrupted,

    #[error("Invalid audio format: {0}")]
    InvalidFormat(String),
}

/// Cryptographic operation errors.
#[derive(Error, Debug)]
pub enum CryptoError {
    #[error("Encryption failed: {0}")]
    Encryption(String),

    #[error("Decryption failed: {0}")]
    Decryption(String),

    #[error("Key derivation failed: {0}")]
    KeyDerivation(String),

    #[error("Invalid key length: expected {expected}, got {actual}")]
    InvalidKeyLength { expected: usize, actual: usize },

    #[error("Authentication tag mismatch")]
    AuthTagMismatch,
}

/// Parsing errors for various formats.
#[derive(Error, Debug)]
pub enum ParseError {
    #[error("Invalid format: {0}")]
    InvalidFormat(String),

    #[error("Missing required field: {0}")]
    MissingField(&'static str),

    #[error("Invalid hex value: {0}")]
    InvalidHex(String),

    #[error("Invalid value: {0}")]
    InvalidValue(String),
}

/// Convenience Result type.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_formats() {
        // Verify error messages are human-readable
        let discovery_err = Error::Discovery(DiscoveryError::NoDevicesFound);
        assert!(discovery_err.to_string().contains("Discovery error"));
        assert!(discovery_err.to_string().contains("No devices found"));

        let pairing_err = Error::Pairing(PairingError::InvalidPin);
        assert!(pairing_err.to_string().contains("Pairing error"));
        assert!(pairing_err.to_string().contains("Invalid PIN"));

        let mfi_err = Error::MfiRequired;
        assert!(mfi_err.to_string().contains("MFi"));

        let timeout_err = Error::Timeout;
        assert!(timeout_err.to_string().contains("timed out"));

        let feature_err = Error::UnsupportedFeature {
            feature: "buffered_audio",
        };
        assert!(feature_err.to_string().contains("buffered_audio"));
    }

    #[test]
    fn error_source_chain() {
        // Verify error source chain works correctly
        use std::error::Error as StdError;

        let io_err = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "test");
        let conn_err = Error::Connection(io_err);
        // The source should be the underlying io::Error
        assert!(conn_err.source().is_some());

        let discovery_err = DiscoveryError::Daemon("test daemon error".to_string());
        let err = Error::Discovery(discovery_err);
        assert!(err.source().is_some());
    }

    #[test]
    fn error_conversions() {
        // Verify From implementations work
        let discovery_err = DiscoveryError::NoDevicesFound;
        let err: Error = discovery_err.into();
        assert!(matches!(err, Error::Discovery(_)));

        let pairing_err = PairingError::InvalidPin;
        let err: Error = pairing_err.into();
        assert!(matches!(err, Error::Pairing(_)));

        let rtsp_err = RtspError::ConnectionRefused;
        let err: Error = rtsp_err.into();
        assert!(matches!(err, Error::Rtsp(_)));

        let streaming_err = StreamingError::BufferUnderrun;
        let err: Error = streaming_err.into();
        assert!(matches!(err, Error::Streaming(_)));

        let crypto_err = CryptoError::AuthTagMismatch;
        let err: Error = crypto_err.into();
        assert!(matches!(err, Error::Crypto(_)));

        let parse_err = ParseError::InvalidHex("bad".to_string());
        let err: Error = parse_err.into();
        assert!(matches!(err, Error::Parse(_)));

        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "test");
        let err: Error = io_err.into();
        assert!(matches!(err, Error::Connection(_)));
    }
}
