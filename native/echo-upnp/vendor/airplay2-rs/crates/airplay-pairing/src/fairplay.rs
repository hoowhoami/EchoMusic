//! FairPlay authentication protocol.
//!
//! FairPlay is used for audio encryption key exchange in AirPlay 2.
//! This is a 2-phase protocol:
//! - Phase 1: Query mode (16 bytes request, 142 bytes response)
//! - Phase 3: Key message (164 bytes request, 32 bytes response)
//!
//! Note: FairPlay uses proprietary cryptographic operations. This implementation
//! provides the message framing and state machine. The actual key generation
//! would require either licensed FairPlay code or reverse-engineered algorithms.

use airplay_core::error::{Error, PairingError, Result};

/// FairPlay protocol header.
pub const FPLY_HEADER: &[u8; 4] = b"FPLY";
/// FairPlay major version for AirPlay 2.
pub const FPLY_VERSION_MAJOR: u8 = 3;
/// FairPlay minor version.
pub const FPLY_VERSION_MINOR: u8 = 0;

/// Phase 1 request size.
const PHASE1_REQUEST_SIZE: usize = 16;
/// Phase 1 response size.
const PHASE1_RESPONSE_SIZE: usize = 142;
/// Phase 3 request size.
const PHASE3_REQUEST_SIZE: usize = 164;
/// Phase 3 response size (session key).
const PHASE3_RESPONSE_SIZE: usize = 32;

/// FairPlay setup state machine.
pub struct FairPlaySetup {
    state: FpState,
    mode: Option<u8>,
    session_key: Option<[u8; 32]>,
    phase1_response: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FpState {
    Initial,
    Phase1Sent,
    Phase1Complete,
    Phase3Sent,
    Complete,
    Failed,
}

impl FairPlaySetup {
    /// Create new FairPlay setup.
    pub fn new() -> Self {
        Self {
            state: FpState::Initial,
            mode: None,
            session_key: None,
            phase1_response: None,
        }
    }

    /// Get current state as string.
    pub fn state(&self) -> &'static str {
        match self.state {
            FpState::Initial => "initial",
            FpState::Phase1Sent => "phase1_sent",
            FpState::Phase1Complete => "phase1_complete",
            FpState::Phase3Sent => "phase3_sent",
            FpState::Complete => "complete",
            FpState::Failed => "failed",
        }
    }

    /// Generate phase 1 request (mode query, 16 bytes).
    ///
    /// Format:
    /// - Bytes 0-3: "FPLY"
    /// - Byte 4: Major version (3)
    /// - Byte 5: Minor version (0)
    /// - Byte 6: Phase (1)
    /// - Bytes 7-15: Padding (zeros)
    pub fn generate_phase1(&mut self) -> Result<Vec<u8>> {
        if self.state != FpState::Initial {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Phase 1 can only be generated from Initial state".to_string(),
            )));
        }

        let mut request = vec![0u8; PHASE1_REQUEST_SIZE];

        // FPLY header
        request[0..4].copy_from_slice(FPLY_HEADER);

        // Version
        request[4] = FPLY_VERSION_MAJOR;
        request[5] = FPLY_VERSION_MINOR;

        // Phase 1
        request[6] = 0x01;

        // Bytes 7-15 are padding (zeros)

        self.state = FpState::Phase1Sent;
        Ok(request)
    }

    /// Process phase 1 response (142 bytes with mode key).
    ///
    /// The response contains:
    /// - Bytes 0-3: "FPLY"
    /// - Byte 4: Major version
    /// - Byte 5: Minor version
    /// - Byte 6: Phase (2)
    /// - Byte 7: Mode
    /// - Bytes 8+: FairPlay public key material
    pub fn process_phase1_response(&mut self, response: &[u8]) -> Result<()> {
        if self.state != FpState::Phase1Sent {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Phase 1 response can only be processed after sending Phase 1".to_string(),
            )));
        }

        if response.len() != PHASE1_RESPONSE_SIZE {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::FairPlayFailed(format!(
                "Phase 1 response has wrong length: {} (expected {})",
                response.len(),
                PHASE1_RESPONSE_SIZE
            ))));
        }

        // Verify FPLY header
        if &response[0..4] != FPLY_HEADER {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::FairPlayFailed(
                "Phase 1 response has invalid FPLY header".to_string(),
            )));
        }

        // Extract mode (byte 7)
        self.mode = Some(response[7]);

        // Store the response for use in phase 3
        self.phase1_response = Some(response.to_vec());

        self.state = FpState::Phase1Complete;
        Ok(())
    }

    /// Generate phase 3 request (164 bytes with key message).
    ///
    /// Format:
    /// - Bytes 0-3: "FPLY"
    /// - Byte 4: Major version (3)
    /// - Byte 5: Minor version (0)
    /// - Byte 6: Phase (3)
    /// - Bytes 7-163: Key message (157 bytes)
    ///
    /// Note: The key message generation requires proprietary FairPlay crypto.
    /// This implementation uses a placeholder that would need to be replaced
    /// with actual FairPlay key message generation.
    pub fn generate_phase3(&mut self) -> Result<Vec<u8>> {
        if self.state != FpState::Phase1Complete {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Phase 3 can only be generated after Phase 1 completes".to_string(),
            )));
        }

        let mut request = vec![0u8; PHASE3_REQUEST_SIZE];

        // FPLY header
        request[0..4].copy_from_slice(FPLY_HEADER);

        // Version
        request[4] = FPLY_VERSION_MAJOR;
        request[5] = FPLY_VERSION_MINOR;

        // Phase 3
        request[6] = 0x03;

        // Bytes 7-163: Key message
        // In a real implementation, this would be generated using FairPlay crypto
        // based on the phase 1 response. For now, we use the mode and phase1 data
        // to generate a deterministic but non-functional key message.
        if let Some(ref phase1_data) = self.phase1_response {
            // Use phase1 data to influence key message (placeholder)
            for i in 7..PHASE3_REQUEST_SIZE.min(phase1_data.len() + 7) {
                request[i] = phase1_data.get(i - 7).copied().unwrap_or(0);
            }
        }

        self.state = FpState::Phase3Sent;
        Ok(request)
    }

    /// Process phase 3 response (32 bytes session key).
    pub fn process_phase3_response(&mut self, response: &[u8]) -> Result<[u8; 32]> {
        if self.state != FpState::Phase3Sent {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::InvalidState(
                "Phase 3 response can only be processed after sending Phase 3".to_string(),
            )));
        }

        if response.len() != PHASE3_RESPONSE_SIZE {
            self.state = FpState::Failed;
            return Err(Error::Pairing(PairingError::FairPlayFailed(format!(
                "Phase 3 response has wrong length: {} (expected {})",
                response.len(),
                PHASE3_RESPONSE_SIZE
            ))));
        }

        let mut session_key = [0u8; 32];
        session_key.copy_from_slice(response);

        self.session_key = Some(session_key);
        self.state = FpState::Complete;

        Ok(session_key)
    }

    /// Get the negotiated session key.
    pub fn session_key(&self) -> Option<&[u8; 32]> {
        self.session_key.as_ref()
    }

    /// Get the mode from phase 1.
    pub fn mode(&self) -> Option<u8> {
        self.mode
    }

    /// Check if setup completed successfully.
    pub fn is_complete(&self) -> bool {
        self.state == FpState::Complete
    }
}

impl Default for FairPlaySetup {
    fn default() -> Self {
        Self::new()
    }
}

/// Mock FairPlay server for testing.
#[cfg(test)]
pub(crate) struct MockFairPlayServer {
    mode: u8,
    session_key: [u8; 32],
}

#[cfg(test)]
impl MockFairPlayServer {
    pub(crate) fn new() -> Self {
        use rand::{rngs::OsRng, RngCore};
        let mut session_key = [0u8; 32];
        OsRng.fill_bytes(&mut session_key);
        Self {
            mode: 0x03, // Default mode
            session_key,
        }
    }

    pub(crate) fn generate_phase1_response(&self) -> Vec<u8> {
        let mut response = vec![0u8; PHASE1_RESPONSE_SIZE];

        // FPLY header
        response[0..4].copy_from_slice(FPLY_HEADER);
        response[4] = FPLY_VERSION_MAJOR;
        response[5] = FPLY_VERSION_MINOR;
        response[6] = 0x02; // Phase 2 (response to phase 1)
        response[7] = self.mode;

        // Fill remaining with pseudo-random data (placeholder for FP public key)
        for i in 8..PHASE1_RESPONSE_SIZE {
            response[i] = ((i * 17) % 256) as u8;
        }

        response
    }

    pub(crate) fn generate_phase3_response(&self) -> Vec<u8> {
        self.session_key.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    mod state_machine {
        use super::*;

        #[test]
        fn starts_in_initial_state() {
            let fp = FairPlaySetup::new();
            assert_eq!(fp.state(), "initial");
        }

        #[test]
        fn transitions_through_phases() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            // Phase 1
            let _ = fp.generate_phase1().unwrap();
            assert_eq!(fp.state(), "phase1_sent");

            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();
            assert_eq!(fp.state(), "phase1_complete");

            // Phase 3
            let _ = fp.generate_phase3().unwrap();
            assert_eq!(fp.state(), "phase3_sent");

            let response3 = server.generate_phase3_response();
            let _key = fp.process_phase3_response(&response3).unwrap();
            assert_eq!(fp.state(), "complete");
            assert!(fp.is_complete());
        }

        #[test]
        fn cannot_skip_phases() {
            let mut fp = FairPlaySetup::new();

            // Try to generate phase 3 without completing phase 1
            let result = fp.generate_phase3();
            assert!(result.is_err());
        }
    }

    mod phase1 {
        use super::*;

        #[test]
        fn phase1_request_is_16_bytes() {
            let mut fp = FairPlaySetup::new();
            let request = fp.generate_phase1().unwrap();
            assert_eq!(request.len(), 16);
        }

        #[test]
        fn phase1_request_starts_with_fply() {
            let mut fp = FairPlaySetup::new();
            let request = fp.generate_phase1().unwrap();
            assert_eq!(&request[0..4], b"FPLY");
        }

        #[test]
        fn phase1_request_has_version_3() {
            let mut fp = FairPlaySetup::new();
            let request = fp.generate_phase1().unwrap();
            assert_eq!(request[4], 3); // Major version
        }

        #[test]
        fn phase1_request_has_phase_1() {
            let mut fp = FairPlaySetup::new();
            let request = fp.generate_phase1().unwrap();
            assert_eq!(request[6], 1); // Phase 1
        }

        #[test]
        fn process_phase1_response_extracts_mode() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response = server.generate_phase1_response();
            fp.process_phase1_response(&response).unwrap();

            assert_eq!(fp.mode(), Some(0x03));
        }

        #[test]
        fn error_on_invalid_response_length() {
            let mut fp = FairPlaySetup::new();
            let _ = fp.generate_phase1().unwrap();

            let short_response = vec![0u8; 50]; // Wrong length
            let result = fp.process_phase1_response(&short_response);
            assert!(result.is_err());
        }

        #[test]
        fn error_on_invalid_fply_header() {
            let mut fp = FairPlaySetup::new();
            let _ = fp.generate_phase1().unwrap();

            let mut response = vec![0u8; PHASE1_RESPONSE_SIZE];
            response[0..4].copy_from_slice(b"XXXX"); // Wrong header

            let result = fp.process_phase1_response(&response);
            assert!(result.is_err());
        }
    }

    mod phase3 {
        use super::*;

        #[test]
        fn phase3_request_is_164_bytes() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();

            let request = fp.generate_phase3().unwrap();
            assert_eq!(request.len(), 164);
        }

        #[test]
        fn phase3_request_starts_with_fply() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();

            let request = fp.generate_phase3().unwrap();
            assert_eq!(&request[0..4], b"FPLY");
        }

        #[test]
        fn phase3_request_has_phase_3() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();

            let request = fp.generate_phase3().unwrap();
            assert_eq!(request[6], 3); // Phase 3
        }

        #[test]
        fn process_phase3_response_returns_session_key() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();

            let _ = fp.generate_phase3().unwrap();
            let response3 = server.generate_phase3_response();
            let session_key = fp.process_phase3_response(&response3).unwrap();

            assert_eq!(session_key.len(), 32);
            assert_eq!(fp.session_key(), Some(&session_key));
        }

        #[test]
        fn error_on_invalid_response_length() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            let _ = fp.generate_phase1().unwrap();
            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();
            let _ = fp.generate_phase3().unwrap();

            let wrong_response = vec![0u8; 16]; // Wrong length
            let result = fp.process_phase3_response(&wrong_response);
            assert!(result.is_err());
        }
    }

    mod integration {
        use super::*;

        #[test]
        fn full_fairplay_flow_with_mock_server() {
            let mut fp = FairPlaySetup::new();
            let server = MockFairPlayServer::new();

            // Phase 1
            let request1 = fp.generate_phase1().unwrap();
            assert_eq!(request1.len(), 16);
            assert_eq!(&request1[0..4], b"FPLY");

            let response1 = server.generate_phase1_response();
            fp.process_phase1_response(&response1).unwrap();
            assert!(fp.mode().is_some());

            // Phase 3
            let request3 = fp.generate_phase3().unwrap();
            assert_eq!(request3.len(), 164);
            assert_eq!(&request3[0..4], b"FPLY");

            let response3 = server.generate_phase3_response();
            let session_key = fp.process_phase3_response(&response3).unwrap();

            // Verify completion
            assert!(fp.is_complete());
            assert_eq!(fp.session_key(), Some(&session_key));
            assert_eq!(session_key.len(), 32);
        }
    }
}
