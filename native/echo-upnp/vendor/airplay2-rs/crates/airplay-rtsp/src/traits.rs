//! Traits for RTSP transport abstraction.

use airplay_core::error::Result;
use async_trait::async_trait;
use crate::{RtspRequest, RtspResponse};

/// RTSP transport trait for testability.
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait RtspTransport: Send + Sync {
    /// Send RTSP request and receive response.
    async fn send(&mut self, request: RtspRequest) -> Result<RtspResponse>;
    
    /// Check if connected.
    fn is_connected(&self) -> bool;
    
    /// Close the connection.
    async fn close(&mut self) -> Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn mock_transport_returns_configured_response() {
        let mut mock = MockRtspTransport::new();

        // Configure the mock to return a specific response
        mock.expect_send().returning(|_request| {
            Box::pin(async {
                Ok(RtspResponse {
                    status_code: 200,
                    status_text: "OK".to_string(),
                    headers: HashMap::new(),
                    body: None,
                })
            })
        });

        mock.expect_is_connected().returning(|| true);

        // Call the mock
        let request = RtspRequest::new(crate::RtspMethod::Get, "/info");
        let response = mock.send(request).await.unwrap();

        assert_eq!(response.status_code, 200);
        assert_eq!(response.status_text, "OK");
        assert!(mock.is_connected());
    }

    #[tokio::test]
    async fn mock_transport_can_simulate_error() {
        let mut mock = MockRtspTransport::new();

        mock.expect_send().returning(|_request| {
            Box::pin(async {
                Err(airplay_core::error::RtspError::ConnectionRefused.into())
            })
        });

        let request = RtspRequest::new(crate::RtspMethod::Get, "/info");
        let result = mock.send(request).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn mock_transport_close_works() {
        let mut mock = MockRtspTransport::new();

        mock.expect_close().returning(|| Box::pin(async { Ok(()) }));

        let result = mock.close().await;
        assert!(result.is_ok());
    }
}
