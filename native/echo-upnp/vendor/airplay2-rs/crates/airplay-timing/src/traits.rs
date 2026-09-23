//! Traits for timing protocol abstraction.

use airplay_core::error::Result;
use async_trait::async_trait;
use crate::ClockOffset;

/// Timing protocol trait for testability.
#[async_trait]
#[cfg_attr(test, mockall::automock)]
pub trait TimingProtocol: Send + Sync {
    /// Start the timing protocol.
    async fn start(&mut self) -> Result<()>;

    /// Stop the timing protocol.
    async fn stop(&mut self) -> Result<()>;

    /// Perform a timing sync and return the calculated offset.
    async fn sync(&mut self) -> Result<ClockOffset>;

    /// Get current clock offset.
    fn offset(&self) -> ClockOffset;

    /// Check if synchronized.
    fn is_synchronized(&self) -> bool;

    /// Convert local timestamp to remote.
    fn local_to_remote(&self, local_ns: u64) -> u64;

    /// Convert remote timestamp to local.
    fn remote_to_local(&self, remote_ns: u64) -> u64;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_timing_protocol() {
        let mut mock = MockTimingProtocol::new();

        // Set up expectations - async methods need Box::pin futures
        mock.expect_start()
            .times(1)
            .returning(|| Box::pin(async { Ok(()) }));

        mock.expect_sync()
            .times(1)
            .returning(|| Box::pin(async {
                Ok(ClockOffset {
                    offset_ns: 1000,
                    error_ns: 50,
                    rtt_ns: 100,
                })
            }));

        mock.expect_offset()
            .times(1)
            .returning(|| ClockOffset {
                offset_ns: 1000,
                error_ns: 50,
                rtt_ns: 100,
            });

        mock.expect_is_synchronized()
            .times(1)
            .returning(|| true);

        mock.expect_local_to_remote()
            .times(1)
            .with(mockall::predicate::eq(5000u64))
            .returning(|local| local + 1000);

        mock.expect_remote_to_local()
            .times(1)
            .with(mockall::predicate::eq(6000u64))
            .returning(|remote| remote - 1000);

        mock.expect_stop()
            .times(1)
            .returning(|| Box::pin(async { Ok(()) }));

        // Test the mock
        mock.start().await.unwrap();

        let offset = mock.sync().await.unwrap();
        assert_eq!(offset.offset_ns, 1000);

        let current = mock.offset();
        assert_eq!(current.offset_ns, 1000);

        assert!(mock.is_synchronized());

        assert_eq!(mock.local_to_remote(5000), 6000);
        assert_eq!(mock.remote_to_local(6000), 5000);

        mock.stop().await.unwrap();
    }
}
