//! Pairing session orchestrator.
//!
//! This module provides a high-level API for managing the complete pairing flow,
//! including HomeKit pair-setup/pair-verify and FairPlay authentication.

use crate::{FairPlaySetup, PairSetup, PairVerify};
use airplay_core::error::{Error, PairingError, Result};
use airplay_core::features::AuthMethod;
use airplay_crypto::ed25519::IdentityKeyPair;
use airplay_crypto::keys::{SessionKeys, SharedSecret};

/// Next action in a pairing flow.
pub enum PairingStep {
    /// Send this request to the receiver.
    Send(Vec<u8>),
    /// Pairing completed with derived session keys.
    Complete(SessionKeys),
}

/// High-level pairing session that orchestrates the full flow.
pub struct PairingSession {
    auth_method: AuthMethod,
    identity: IdentityKeyPair,
    pair_setup: Option<PairSetup>,
    pair_setup_state: PairSetupStage,
    transient_setup: Option<PairSetup>,
    transient_state: TransientStage,
    pair_verify: Option<PairVerify>,
    pair_verify_state: PairVerifyStage,
    fairplay: Option<FairPlaySetup>,
    fairplay_state: FairPlayStage,
    shared_secret: Option<SharedSecret>,
    session_keys: Option<SessionKeys>,
}

/// Pair-setup stage tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairSetupStage {
    NotStarted,
    WaitingM2,
    WaitingM4,
    WaitingM6,
    Complete,
}

/// Pair-verify stage tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PairVerifyStage {
    NotStarted,
    WaitingM2,
    WaitingM4,
    Complete,
}

/// FairPlay stage tracking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FairPlayStage {
    NotStarted,
    WaitingPhase1Response,
    WaitingPhase3Response,
    Complete,
}

/// Transient pairing stage tracking (SRP M1-M4 flow).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransientStage {
    NotStarted,
    WaitingM2,
    WaitingM4,
    Complete,
}

impl PairingSession {
    /// Create new pairing session for the given auth method.
    pub fn new(auth_method: AuthMethod) -> Self {
        Self {
            auth_method,
            identity: IdentityKeyPair::generate(),
            pair_setup: None,
            pair_setup_state: PairSetupStage::NotStarted,
            transient_setup: None,
            transient_state: TransientStage::NotStarted,
            pair_verify: None,
            pair_verify_state: PairVerifyStage::NotStarted,
            fairplay: None,
            fairplay_state: FairPlayStage::NotStarted,
            shared_secret: None,
            session_keys: None,
        }
    }

    /// Create with a specific identity key pair.
    pub fn with_identity(auth_method: AuthMethod, identity: IdentityKeyPair) -> Self {
        Self {
            auth_method,
            identity,
            pair_setup: None,
            pair_setup_state: PairSetupStage::NotStarted,
            transient_setup: None,
            transient_state: TransientStage::NotStarted,
            pair_verify: None,
            pair_verify_state: PairVerifyStage::NotStarted,
            fairplay: None,
            fairplay_state: FairPlayStage::NotStarted,
            shared_secret: None,
            session_keys: None,
        }
    }

    /// Start pair-setup with PIN.
    ///
    /// Returns M1 request to send to the device.
    pub fn start_pair_setup(&mut self, pin: &str) -> Result<Vec<u8>> {
        if self.pair_setup.is_some() {
            return Err(Error::Pairing(PairingError::InvalidState(
                "Pair-setup already started".to_string(),
            )));
        }

        let mut pair_setup = PairSetup::new(pin);
        let m1 = pair_setup.generate_m1()?;

        self.pair_setup = Some(pair_setup);
        self.pair_setup_state = PairSetupStage::WaitingM2;

        Ok(m1)
    }

    /// Continue pair-setup with server response.
    ///
    /// Returns the next request to send, or None if pair-setup is complete.
    pub fn continue_pair_setup(&mut self, response: &[u8]) -> Result<Option<Vec<u8>>> {
        let pair_setup = self.pair_setup.as_mut().ok_or_else(|| {
            Error::Pairing(PairingError::InvalidState(
                "Pair-setup not started".to_string(),
            ))
        })?;

        match self.pair_setup_state {
            PairSetupStage::WaitingM2 => {
                pair_setup.process_m2(response)?;
                let m3 = pair_setup.generate_m3()?;
                self.pair_setup_state = PairSetupStage::WaitingM4;
                Ok(Some(m3))
            }
            PairSetupStage::WaitingM4 => {
                pair_setup.process_m4(response)?;
                let m5 = pair_setup.generate_m5(&self.identity)?;
                self.pair_setup_state = PairSetupStage::WaitingM6;
                Ok(Some(m5))
            }
            PairSetupStage::WaitingM6 => {
                let shared_secret = pair_setup.process_m6(response)?;
                self.shared_secret = Some(shared_secret);
                self.pair_setup_state = PairSetupStage::Complete;
                Ok(None)
            }
            _ => Err(Error::Pairing(PairingError::InvalidState(
                "Invalid pair-setup state for continue".to_string(),
            ))),
        }
    }

    // ========================================================================
    // Transient Pairing (SRP M1-M4 with PIN "3939", no pair-verify needed)
    // ========================================================================

    /// Start transient pairing (SRP with transient flag) using the default PIN.
    ///
    /// This is the correct transient pairing flow for devices that support
    /// feature bit 51 (SupportsUnifiedPairSetupAndMFi):
    /// 1. Send M1 with Flags=0x10 (kPairingFlag_Transient)
    /// 2. Receive M2 with SRP salt and public key
    /// 3. Send M3 with SRP client proof
    /// 4. Receive M4 with SRP server proof
    /// 5. Derive shared secret via SRP (no M5/M6 identity exchange needed)
    ///
    /// Uses hardcoded PIN "3939" for transient mode.
    /// After M4 completes, session keys are derived directly.
    ///
    /// Returns M1 request to send to /pair-setup endpoint.
    pub fn start_transient_pairing(&mut self) -> Result<Vec<u8>> {
        if self.transient_setup.is_some() {
            return Err(Error::Pairing(PairingError::InvalidState(
                "Transient pairing already started".to_string(),
            )));
        }

        self.start_transient_pairing_with_pin("3939")
    }

    /// Start transient pairing (SRP with transient flag) using a custom PIN.
    pub fn start_transient_pairing_with_pin(&mut self, pin: &str) -> Result<Vec<u8>> {
        if self.transient_setup.is_some() {
            return Err(Error::Pairing(PairingError::InvalidState(
                "Transient pairing already started".to_string(),
            )));
        }

        let mut transient = PairSetup::new_transient_with_pin(pin);
        let m1 = transient.generate_m1()?;

        self.transient_setup = Some(transient);
        self.transient_state = TransientStage::WaitingM2;

        Ok(m1)
    }

    /// Start transient pairing and return the first request to send.
    pub fn transient_pairing_start(&mut self, pin: &str) -> Result<PairingStep> {
        let m1 = self.start_transient_pairing_with_pin(pin)?;
        Ok(PairingStep::Send(m1))
    }

    /// Continue transient pairing with server response.
    ///
    /// Handles the SRP M1-M4 flow:
    /// - After M1: receives M2 (salt + server public key), returns M3 (client proof)
    /// - After M3: receives M4 (server proof), returns None (complete)
    ///
    /// Returns the next request to send, or None when complete.
    pub fn continue_transient_pairing(&mut self, response: &[u8]) -> Result<Option<Vec<u8>>> {
        let transient = self.transient_setup.as_mut().ok_or_else(|| {
            Error::Pairing(PairingError::InvalidState(
                "Transient pairing not started".to_string(),
            ))
        })?;

        match self.transient_state {
            TransientStage::WaitingM2 => {
                // Process M2 (SRP salt + server public key)
                transient.process_m2(response)?;
                // Generate M3 (client proof)
                let m3 = transient.generate_m3()?;
                self.transient_state = TransientStage::WaitingM4;
                Ok(Some(m3))
            }
            TransientStage::WaitingM4 => {
                // Process M4 (server proof)
                transient.process_m4(response)?;
                // Complete transient pairing - get shared secret
                let shared_secret = transient.complete_transient()?;

                // Derive session keys directly from the SRP shared secret
                let keys = SessionKeys::derive_control_keys(&shared_secret)?;

                self.shared_secret = Some(shared_secret);
                self.session_keys = Some(keys);
                self.transient_state = TransientStage::Complete;

                Ok(None) // Complete - no more messages needed
            }
            _ => Err(Error::Pairing(PairingError::InvalidState(
                "Invalid transient state for continue".to_string(),
            ))),
        }
    }

    /// Continue transient pairing and return either the next request or final keys.
    pub fn transient_pairing_continue(&mut self, response: &[u8]) -> Result<PairingStep> {
        match self.continue_transient_pairing(response)? {
            Some(next) => Ok(PairingStep::Send(next)),
            None => {
                let keys = self.take_session_keys().ok_or_else(|| {
                    Error::Pairing(PairingError::Protocol(
                        "Transient pairing completed without session keys".to_string(),
                    ))
                })?;
                Ok(PairingStep::Complete(keys))
            }
        }
    }

    /// Check if transient pairing is complete.
    pub fn is_transient_complete(&self) -> bool {
        self.transient_state == TransientStage::Complete
    }

    // ========================================================================
    // Pair-Verify (standard ECDH + signature verification)
    // ========================================================================

    /// Start pair-verify.
    ///
    /// Returns M1 request to send to the device.
    pub fn start_pair_verify(&mut self) -> Result<Vec<u8>> {
        if self.pair_verify.is_some() {
            return Err(Error::Pairing(PairingError::InvalidState(
                "Pair-verify already started".to_string(),
            )));
        }

        let mut pair_verify = PairVerify::new(self.identity.clone());
        let m1 = pair_verify.generate_m1()?;

        self.pair_verify = Some(pair_verify);
        self.pair_verify_state = PairVerifyStage::WaitingM2;

        Ok(m1)
    }

    /// Continue pair-verify with server response.
    ///
    /// Returns the next request to send, or None if pair-verify is complete.
    pub fn continue_pair_verify(&mut self, response: &[u8]) -> Result<Option<Vec<u8>>> {
        let pair_verify = self.pair_verify.as_mut().ok_or_else(|| {
            Error::Pairing(PairingError::InvalidState(
                "Pair-verify not started".to_string(),
            ))
        })?;

        match self.pair_verify_state {
            PairVerifyStage::WaitingM2 => {
                pair_verify.process_m2(response)?;
                let m3 = pair_verify.generate_m3()?;
                self.pair_verify_state = PairVerifyStage::WaitingM4;
                Ok(Some(m3))
            }
            PairVerifyStage::WaitingM4 => {
                let session_keys = pair_verify.process_m4(response)?;
                self.session_keys = Some(session_keys);
                self.pair_verify_state = PairVerifyStage::Complete;
                Ok(None)
            }
            _ => Err(Error::Pairing(PairingError::InvalidState(
                "Invalid pair-verify state for continue".to_string(),
            ))),
        }
    }

    /// Start FairPlay setup.
    ///
    /// Returns phase 1 request to send to the device.
    pub fn start_fairplay(&mut self) -> Result<Vec<u8>> {
        if self.fairplay.is_some() {
            return Err(Error::Pairing(PairingError::InvalidState(
                "FairPlay already started".to_string(),
            )));
        }

        let mut fairplay = FairPlaySetup::new();
        let phase1 = fairplay.generate_phase1()?;

        self.fairplay = Some(fairplay);
        self.fairplay_state = FairPlayStage::WaitingPhase1Response;

        Ok(phase1)
    }

    /// Continue FairPlay with server response.
    ///
    /// Returns the next request to send, or None if FairPlay is complete.
    pub fn continue_fairplay(&mut self, response: &[u8]) -> Result<Option<Vec<u8>>> {
        let fairplay = self.fairplay.as_mut().ok_or_else(|| {
            Error::Pairing(PairingError::InvalidState(
                "FairPlay not started".to_string(),
            ))
        })?;

        match self.fairplay_state {
            FairPlayStage::WaitingPhase1Response => {
                fairplay.process_phase1_response(response)?;
                let phase3 = fairplay.generate_phase3()?;
                self.fairplay_state = FairPlayStage::WaitingPhase3Response;
                Ok(Some(phase3))
            }
            FairPlayStage::WaitingPhase3Response => {
                let _session_key = fairplay.process_phase3_response(response)?;
                self.fairplay_state = FairPlayStage::Complete;
                Ok(None)
            }
            _ => Err(Error::Pairing(PairingError::InvalidState(
                "Invalid FairPlay state for continue".to_string(),
            ))),
        }
    }

    /// Get session keys after successful pairing.
    pub fn session_keys(&self) -> Option<&SessionKeys> {
        self.session_keys.as_ref()
    }

    /// Get the shared secret derived during pair-setup or pair-verify.
    pub fn shared_secret(&self) -> Option<&SharedSecret> {
        self.shared_secret.as_ref()
    }

    /// Take session keys after successful pairing.
    pub fn take_session_keys(&mut self) -> Option<SessionKeys> {
        self.session_keys.take()
    }

    /// Get the identity key pair.
    pub fn identity(&self) -> &IdentityKeyPair {
        &self.identity
    }

    /// Check if pair-setup is complete.
    pub fn is_pair_setup_complete(&self) -> bool {
        self.pair_setup_state == PairSetupStage::Complete
    }

    /// Check if pair-verify is complete.
    pub fn is_pair_verify_complete(&self) -> bool {
        self.pair_verify_state == PairVerifyStage::Complete
    }

    /// Check if FairPlay is complete.
    pub fn is_fairplay_complete(&self) -> bool {
        self.fairplay_state == FairPlayStage::Complete
    }

    /// Check if full pairing is complete.
    pub fn is_complete(&self) -> bool {
        self.session_keys.is_some()
    }

    /// Get required auth method.
    pub fn auth_method(&self) -> AuthMethod {
        self.auth_method
    }

    /// Get FairPlay session key if available.
    pub fn fairplay_session_key(&self) -> Option<&[u8; 32]> {
        self.fairplay.as_ref().and_then(|fp| fp.session_key())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pair_setup::MockSetupServer;
    use crate::pair_verify::MockVerifyServer;

    mod session_creation {
        use super::*;

        #[test]
        fn creates_with_auth_method() {
            let session = PairingSession::new(AuthMethod::HomeKitTransient);
            assert_eq!(session.auth_method(), AuthMethod::HomeKitTransient);
        }

        #[test]
        fn starts_without_session_keys() {
            let session = PairingSession::new(AuthMethod::HomeKitTransient);
            assert!(session.session_keys().is_none());
            assert!(!session.is_complete());
        }

        #[test]
        fn creates_with_custom_identity() {
            let identity = IdentityKeyPair::generate();
            let pk = identity.public_key();
            let session = PairingSession::with_identity(AuthMethod::HomeKitTransient, identity);
            assert_eq!(session.identity().public_key(), pk);
        }
    }

    mod pair_setup_flow {
        use super::*;

        #[test]
        fn start_pair_setup_initializes_state() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let m1 = session.start_pair_setup("1234").unwrap();
            assert!(!m1.is_empty());
            assert!(!session.is_pair_setup_complete());
        }

        #[test]
        fn continue_pair_setup_advances_state() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut server = MockSetupServer::new("1234");

            // Start with M1
            let _ = session.start_pair_setup("1234").unwrap();

            // M2 -> M3
            let m2 = server.generate_m2();
            let m3 = session.continue_pair_setup(&m2).unwrap();
            assert!(m3.is_some());

            // M4 -> M5
            let m4 = server.process_m3(&m3.unwrap()).unwrap();
            let m5 = session.continue_pair_setup(&m4).unwrap();
            assert!(m5.is_some());
        }

        #[test]
        fn pair_setup_completion_enables_pair_verify() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut server = MockSetupServer::new("1234");

            // Complete pair-setup
            let _ = session.start_pair_setup("1234").unwrap();

            let m2 = server.generate_m2();
            let m3 = session.continue_pair_setup(&m2).unwrap().unwrap();

            let m4 = server.process_m3(&m3).unwrap();
            let m5 = session.continue_pair_setup(&m4).unwrap().unwrap();

            let m6 = server.process_m5(&m5).unwrap();
            let result = session.continue_pair_setup(&m6).unwrap();
            assert!(result.is_none()); // No more messages

            assert!(session.is_pair_setup_complete());
        }
    }

    mod transient_flow_session_keys {
        use super::*;

        #[test]
        fn transient_pairing_completes_and_derives_keys() {
            let identity = IdentityKeyPair::generate();
            let mut session = PairingSession::with_identity(AuthMethod::HomeKitTransient, identity);
            let mut server = MockSetupServer::new("1234");

            let _m1 = session.start_transient_pairing_with_pin("1234").unwrap();
            let m2 = server.generate_m2();
            let m3 = session.continue_transient_pairing(&m2).unwrap().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            let done = session.continue_transient_pairing(&m4).unwrap();

            assert!(done.is_none());
            assert!(session.session_keys().is_some());
        }

        #[test]
        fn take_session_keys_consumes_keys() {
            let identity = IdentityKeyPair::generate();
            let mut session = PairingSession::with_identity(AuthMethod::HomeKitTransient, identity);
            let mut server = MockSetupServer::new("1234");

            let _m1 = session.start_transient_pairing_with_pin("1234").unwrap();
            let m2 = server.generate_m2();
            let m3 = session.continue_transient_pairing(&m2).unwrap().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            let _ = session.continue_transient_pairing(&m4).unwrap();

            let keys = session.take_session_keys();
            assert!(keys.is_some());
            assert!(session.session_keys().is_none());
        }

        #[test]
        fn transient_pairing_step_api() {
            let identity = IdentityKeyPair::generate();
            let mut session = PairingSession::with_identity(AuthMethod::HomeKitTransient, identity);
            let mut server = MockSetupServer::new("1234");

            let step = session.transient_pairing_start("1234").unwrap();
            let _m1 = match step {
                PairingStep::Send(m1) => m1,
                PairingStep::Complete(_) => panic!("unexpected completion on start"),
            };

            let m2 = server.generate_m2();
            let step = session.transient_pairing_continue(&m2).unwrap();
            let m3 = match step {
                PairingStep::Send(m3) => m3,
                PairingStep::Complete(_) => panic!("unexpected completion after M2"),
            };

            let m4 = server.process_m3(&m3).unwrap();
            let step = session.transient_pairing_continue(&m4).unwrap();
            match step {
                PairingStep::Send(_) => panic!("expected completion after M4"),
                PairingStep::Complete(keys) => {
                    assert_eq!(keys.write_key.as_bytes().len(), 32);
                    assert_eq!(keys.read_key.as_bytes().len(), 32);
                }
            }

            assert!(session.session_keys().is_none());
        }
    }

    mod transient_flow {
        use super::*;

        #[test]
        fn start_transient_pairing_initializes_state() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let m1 = session.start_transient_pairing().unwrap();
            assert!(!m1.is_empty());
            assert!(!session.is_transient_complete());
        }

        #[test]
        fn m1_contains_transient_flag() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let m1 = session.start_transient_pairing().unwrap();

            // Parse M1 and verify it has the transient flag
            use airplay_crypto::tlv::{Tlv8, TlvType};
            let tlv = Tlv8::parse(&m1).unwrap();
            assert_eq!(tlv.state(), Some(0x01));
            assert_eq!(tlv.get(TlvType::Method), Some(&[0x00][..]));
            // Transient flag should be 0x10 as 4-byte LE
            let flags = tlv.get(TlvType::Flags).unwrap();
            assert_eq!(flags, &[0x10, 0x00, 0x00, 0x00]);
        }

        #[test]
        fn cannot_start_transient_twice() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let _ = session.start_transient_pairing().unwrap();
            let result = session.start_transient_pairing();
            assert!(result.is_err());
        }

        #[test]
        fn transient_pairing_full_flow() {
            // Use MockSetupServer with PIN "3939" (the transient PIN)
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut server = MockSetupServer::new("3939");

            // M1: Client starts transient pairing
            let _m1 = session.start_transient_pairing().unwrap();
            assert!(!session.is_transient_complete());

            // M2: Server sends SRP salt + public key
            let m2 = server.generate_m2();
            let m3_result = session.continue_transient_pairing(&m2).unwrap();
            assert!(m3_result.is_some()); // Should return M3

            // M3 -> M4: Client sends proof, server verifies
            let m3 = m3_result.unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            let result = session.continue_transient_pairing(&m4).unwrap();
            assert!(result.is_none()); // Complete after M4

            // Verify session is complete
            assert!(session.is_transient_complete());
            assert!(session.is_complete());
            assert!(session.session_keys().is_some());
        }

        #[test]
        fn transient_pairing_derives_session_keys() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut server = MockSetupServer::new("3939");

            // Complete the flow
            let _ = session.start_transient_pairing().unwrap();
            let m2 = server.generate_m2();
            let m3 = session.continue_transient_pairing(&m2).unwrap().unwrap();
            let m4 = server.process_m3(&m3).unwrap();
            session.continue_transient_pairing(&m4).unwrap();

            // Verify session keys are derived
            let keys = session.session_keys().unwrap();
            assert!(!keys.write_key.as_bytes().iter().all(|&b| b == 0));
            assert!(!keys.read_key.as_bytes().iter().all(|&b| b == 0));
        }

        #[test]
        fn cannot_continue_without_starting() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            // Try to continue without starting
            let result = session.continue_transient_pairing(&[]);
            assert!(result.is_err());
        }

        #[test]
        fn transient_pairing_with_wrong_pin_fails() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            // Server uses different PIN than "3939"
            let mut server = MockSetupServer::new("0000");

            let _ = session.start_transient_pairing().unwrap();
            let m2 = server.generate_m2();
            let m3 = session.continue_transient_pairing(&m2).unwrap().unwrap();
            let m4 = server.process_m3(&m3).unwrap();

            // M4 verification should fail because SRP proofs don't match
            let result = session.continue_transient_pairing(&m4);
            assert!(result.is_err());
        }
    }

    mod pair_verify_flow {
        use super::*;

        #[test]
        fn start_pair_verify_initializes_state() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let m1 = session.start_pair_verify().unwrap();
            assert!(!m1.is_empty());
            assert!(!session.is_pair_verify_complete());
        }

        #[test]
        fn pair_verify_completion_yields_session_keys() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut server = MockVerifyServer::new();

            // M1
            let m1 = session.start_pair_verify().unwrap();

            // M2 -> M3
            let m2 = server.process_m1(&m1).unwrap();
            let m3 = session.continue_pair_verify(&m2).unwrap().unwrap();

            // M4
            let m4 = server.process_m3(&m3).unwrap();
            let result = session.continue_pair_verify(&m4).unwrap();
            assert!(result.is_none()); // Complete

            assert!(session.is_pair_verify_complete());
            assert!(session.is_complete());
            assert!(session.session_keys().is_some());
        }
    }

    mod fairplay_flow {
        use super::*;
        use crate::fairplay::MockFairPlayServer;

        #[test]
        fn start_fairplay_initializes_state() {
            let mut session = PairingSession::new(AuthMethod::FairPlay);
            let phase1 = session.start_fairplay().unwrap();
            assert_eq!(phase1.len(), 16);
            assert!(!session.is_fairplay_complete());
        }

        #[test]
        fn fairplay_completion_updates_session() {
            let mut session = PairingSession::new(AuthMethod::FairPlay);
            let server = MockFairPlayServer::new();

            // Phase 1
            let _ = session.start_fairplay().unwrap();
            let response1 = server.generate_phase1_response();
            let phase3 = session.continue_fairplay(&response1).unwrap().unwrap();
            assert_eq!(phase3.len(), 164);

            // Phase 3
            let response3 = server.generate_phase3_response();
            let result = session.continue_fairplay(&response3).unwrap();
            assert!(result.is_none()); // Complete

            assert!(session.is_fairplay_complete());
            assert!(session.fairplay_session_key().is_some());
        }
    }

    mod full_flow {
        use super::*;
        use crate::fairplay::MockFairPlayServer;

        #[test]
        fn homekit_transient_full_flow() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let mut setup_server = MockSetupServer::new("1234");
            let mut verify_server = MockVerifyServer::new();

            // Pair-setup M1-M6
            let _ = session.start_pair_setup("1234").unwrap();
            let m2 = setup_server.generate_m2();
            let m3 = session.continue_pair_setup(&m2).unwrap().unwrap();
            let m4 = setup_server.process_m3(&m3).unwrap();
            let m5 = session.continue_pair_setup(&m4).unwrap().unwrap();
            let m6 = setup_server.process_m5(&m5).unwrap();
            session.continue_pair_setup(&m6).unwrap();

            assert!(session.is_pair_setup_complete());

            // Pair-verify M1-M4
            let m1 = session.start_pair_verify().unwrap();
            let m2 = verify_server.process_m1(&m1).unwrap();
            let m3 = session.continue_pair_verify(&m2).unwrap().unwrap();
            let m4 = verify_server.process_m3(&m3).unwrap();
            session.continue_pair_verify(&m4).unwrap();

            assert!(session.is_pair_verify_complete());
            assert!(session.is_complete());
            assert!(session.session_keys().is_some());
        }

        #[test]
        fn fairplay_required_full_flow() {
            let mut session = PairingSession::new(AuthMethod::FairPlay);
            let fp_server = MockFairPlayServer::new();
            let mut verify_server = MockVerifyServer::new();

            // FairPlay phases 1 & 3
            let _ = session.start_fairplay().unwrap();
            let response1 = fp_server.generate_phase1_response();
            let phase3 = session.continue_fairplay(&response1).unwrap().unwrap();
            let response3 = fp_server.generate_phase3_response();
            session.continue_fairplay(&response3).unwrap();

            assert!(session.is_fairplay_complete());

            // Pair-verify M1-M4
            let m1 = session.start_pair_verify().unwrap();
            let m2 = verify_server.process_m1(&m1).unwrap();
            let m3 = session.continue_pair_verify(&m2).unwrap().unwrap();
            let m4 = verify_server.process_m3(&m3).unwrap();
            session.continue_pair_verify(&m4).unwrap();

            assert!(session.is_pair_verify_complete());
            assert!(session.is_complete());
        }
    }

    mod error_handling {
        use super::*;

        #[test]
        fn cannot_start_pair_setup_twice() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let _ = session.start_pair_setup("1234").unwrap();
            let result = session.start_pair_setup("1234");
            assert!(result.is_err());
        }

        #[test]
        fn cannot_start_pair_verify_twice() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let _ = session.start_pair_verify().unwrap();
            let result = session.start_pair_verify();
            assert!(result.is_err());
        }

        #[test]
        fn cannot_start_fairplay_twice() {
            let mut session = PairingSession::new(AuthMethod::FairPlay);
            let _ = session.start_fairplay().unwrap();
            let result = session.start_fairplay();
            assert!(result.is_err());
        }

        #[test]
        fn cannot_continue_without_starting() {
            let mut session = PairingSession::new(AuthMethod::HomeKitTransient);
            let result = session.continue_pair_setup(&[]);
            assert!(result.is_err());
        }
    }
}
