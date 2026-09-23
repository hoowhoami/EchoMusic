//! Error types for Bluetooth operations.

use thiserror::Error;

/// Bluetooth-specific error types.
#[derive(Error, Debug)]
pub enum BluetoothError {
    /// Bluetooth adapter not found.
    #[error("Bluetooth adapter not found")]
    AdapterNotFound,

    /// Adapter is powered off.
    #[error("Bluetooth adapter is powered off")]
    AdapterPoweredOff,

    /// Device not found.
    #[error("Bluetooth device not found: {0}")]
    DeviceNotFound(String),

    /// Pairing failed.
    #[error("Pairing failed: {0}")]
    PairingFailed(String),

    /// Connection failed.
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    /// Device is not connected.
    #[error("Device is not connected")]
    NotConnected,

    /// Device does not support A2DP.
    #[error("Device does not support A2DP audio")]
    A2dpNotSupported,

    /// ALSA error during audio capture.
    #[error("ALSA error: {0}")]
    Alsa(String),

    /// Audio capture channel closed.
    #[error("Audio capture stopped")]
    CaptureStopped,

    /// System setup issue.
    #[error("System setup error: {0}")]
    Setup(String),

    /// BlueZ D-Bus error.
    #[error("BlueZ error: {0}")]
    BlueZ(String),

    /// Operation timed out.
    #[error("Operation timed out")]
    Timeout,

    /// Operation cancelled.
    #[error("Operation cancelled")]
    Cancelled,

    /// Cannot seek in live stream.
    #[error("Cannot seek in live Bluetooth stream")]
    CannotSeek,

    /// I/O error.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// Convenience Result type for Bluetooth operations.
pub type Result<T> = std::result::Result<T, BluetoothError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_formats() {
        let err = BluetoothError::AdapterNotFound;
        assert!(err.to_string().contains("adapter not found"));

        let err = BluetoothError::PairingFailed("rejected".to_string());
        assert!(err.to_string().contains("Pairing failed"));
        assert!(err.to_string().contains("rejected"));

        let err = BluetoothError::Alsa("buffer underrun".to_string());
        assert!(err.to_string().contains("ALSA"));
        assert!(err.to_string().contains("buffer underrun"));
    }

    #[test]
    fn io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "test");
        let err: BluetoothError = io_err.into();
        assert!(matches!(err, BluetoothError::Io(_)));
    }
}
