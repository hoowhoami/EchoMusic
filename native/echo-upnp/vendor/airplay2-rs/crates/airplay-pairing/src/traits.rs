//! Traits for pairing transport and handling.

use airplay_core::error::Result;
use async_trait::async_trait;

/// Transport for sending pairing requests.
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait Transport: Send + Sync {
    /// Send pair-setup request to /pair-setup endpoint.
    async fn pair_setup(&mut self, request: &[u8]) -> Result<Vec<u8>>;

    /// Send pair-verify request to /pair-verify endpoint.
    async fn pair_verify(&mut self, request: &[u8]) -> Result<Vec<u8>>;

    /// Send FairPlay request to /fp-setup endpoint.
    async fn fp_setup(&mut self, request: &[u8]) -> Result<Vec<u8>>;
}

/// Handler for pairing state changes.
pub trait PairingHandler: Send + Sync {
    /// Called when PIN input is required.
    fn on_pin_required(&self) -> String;

    /// Called when pairing starts.
    fn on_pairing_started(&self) {}

    /// Called when pairing completes successfully.
    fn on_pairing_complete(&self) {}

    /// Called when pairing fails.
    fn on_pairing_failed(&self, _error: &str) {}
}

/// Default handler that uses hardcoded PIN.
pub struct DefaultPairingHandler {
    pin: String,
}

impl DefaultPairingHandler {
    pub fn new(pin: impl Into<String>) -> Self {
        Self { pin: pin.into() }
    }
}

impl Default for DefaultPairingHandler {
    fn default() -> Self {
        // HomePod uses "3939" as the default PIN for transient pairing
        Self::new("3939")
    }
}

impl PairingHandler for DefaultPairingHandler {
    fn on_pin_required(&self) -> String {
        self.pin.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod mock_transport {
        use super::*;

        #[tokio::test]
        async fn mock_pair_setup_returns_configured_response() {
            let mut mock = MockTransport::new();

            let expected_response = vec![0x06, 0x01, 0x02]; // State=2
            let expected_clone = expected_response.clone();

            mock.expect_pair_setup()
                .returning(move |_| Box::pin({
                    let resp = expected_clone.clone();
                    async move { Ok(resp) }
                }));

            let result = mock.pair_setup(&[0x06, 0x01, 0x01]).await.unwrap();
            assert_eq!(result, expected_response);
        }

        #[tokio::test]
        async fn mock_pair_verify_returns_configured_response() {
            let mut mock = MockTransport::new();

            let expected_response = vec![0x06, 0x01, 0x02]; // State=2
            let expected_clone = expected_response.clone();

            mock.expect_pair_verify()
                .returning(move |_| Box::pin({
                    let resp = expected_clone.clone();
                    async move { Ok(resp) }
                }));

            let result = mock.pair_verify(&[0x06, 0x01, 0x01]).await.unwrap();
            assert_eq!(result, expected_response);
        }

        #[tokio::test]
        async fn mock_fp_setup_returns_configured_response() {
            let mut mock = MockTransport::new();

            let expected_response = vec![0x46, 0x50, 0x4C, 0x59]; // FPLY
            let expected_clone = expected_response.clone();

            mock.expect_fp_setup()
                .returning(move |_| Box::pin({
                    let resp = expected_clone.clone();
                    async move { Ok(resp) }
                }));

            let result = mock.fp_setup(&[]).await.unwrap();
            assert_eq!(result, expected_response);
        }
    }

    mod default_handler {
        use super::*;

        #[test]
        fn returns_configured_pin() {
            let handler = DefaultPairingHandler::new("1234");
            assert_eq!(handler.on_pin_required(), "1234");
        }

        #[test]
        fn default_pin_is_3939() {
            let handler = DefaultPairingHandler::default();
            assert_eq!(handler.on_pin_required(), "3939");
        }

        #[test]
        fn callbacks_do_not_panic() {
            let handler = DefaultPairingHandler::new("1234");
            handler.on_pairing_started();
            handler.on_pairing_complete();
            handler.on_pairing_failed("test error");
        }
    }
}
