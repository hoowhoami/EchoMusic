//! System setup verification for Bluetooth audio.
//!
//! Checks that required system components (BlueZ, BlueALSA) are installed and running.

use std::process::Command;
use crate::error::{BluetoothError, Result};

/// Status of a system component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComponentStatus {
    /// Component is installed and running.
    Ok,
    /// Component is installed but not running.
    NotRunning,
    /// Component is not installed.
    NotInstalled,
    /// Unable to determine status.
    Unknown,
}

/// A single setup issue with suggested fix.
#[derive(Debug, Clone)]
pub struct SetupIssue {
    /// Description of the issue.
    pub description: String,
    /// Suggested command to fix the issue.
    pub fix_command: Option<String>,
}

/// Overall system setup status.
#[derive(Debug, Clone)]
pub struct SetupStatus {
    /// BlueZ daemon status.
    pub bluez: ComponentStatus,
    /// BlueALSA daemon status.
    pub bluealsa: ComponentStatus,
    /// List of issues found.
    pub issues: Vec<SetupIssue>,
    /// Whether the system is ready for Bluetooth audio.
    pub ready: bool,
}

impl SetupStatus {
    /// Get a summary message for the status.
    pub fn summary(&self) -> String {
        if self.ready {
            "System is ready for Bluetooth audio".to_string()
        } else {
            format!("{} issue(s) found", self.issues.len())
        }
    }
}

/// System setup verification and auto-installation.
pub struct SystemSetup;

impl SystemSetup {
    /// Check system setup status.
    ///
    /// Returns a `SetupStatus` with the current state of required components.
    pub fn check() -> SetupStatus {
        let mut issues = Vec::new();

        // Check BlueZ
        let bluez = Self::check_bluez();
        if bluez != ComponentStatus::Ok {
            issues.push(SetupIssue {
                description: match bluez {
                    ComponentStatus::NotInstalled => "BlueZ is not installed".to_string(),
                    ComponentStatus::NotRunning => "Bluetooth service is not running".to_string(),
                    _ => "BlueZ status unknown".to_string(),
                },
                fix_command: Some(match bluez {
                    ComponentStatus::NotInstalled => {
                        "sudo apt install bluez".to_string()
                    }
                    ComponentStatus::NotRunning => {
                        "sudo systemctl start bluetooth".to_string()
                    }
                    _ => "sudo systemctl status bluetooth".to_string(),
                }),
            });
        }

        // Check BlueALSA
        let bluealsa = Self::check_bluealsa();
        if bluealsa != ComponentStatus::Ok {
            issues.push(SetupIssue {
                description: match bluealsa {
                    ComponentStatus::NotInstalled => "BlueALSA is not installed".to_string(),
                    ComponentStatus::NotRunning => "BlueALSA service is not running".to_string(),
                    _ => "BlueALSA status unknown".to_string(),
                },
                fix_command: Some(match bluealsa {
                    ComponentStatus::NotInstalled => {
                        "sudo apt install bluez-alsa-utils".to_string()
                    }
                    ComponentStatus::NotRunning => {
                        "sudo systemctl start bluealsa".to_string()
                    }
                    _ => "sudo systemctl status bluealsa".to_string(),
                }),
            });
        }

        let ready = bluez == ComponentStatus::Ok && bluealsa == ComponentStatus::Ok;

        SetupStatus {
            bluez,
            bluealsa,
            issues,
            ready,
        }
    }

    /// Check BlueZ daemon status.
    fn check_bluez() -> ComponentStatus {
        // Check if bluetoothctl exists (indicates BlueZ is installed)
        let installed = Command::new("which")
            .arg("bluetoothctl")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !installed {
            return ComponentStatus::NotInstalled;
        }

        // Check if bluetooth service is running
        let running = Command::new("systemctl")
            .args(["is-active", "--quiet", "bluetooth"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if running {
            ComponentStatus::Ok
        } else {
            ComponentStatus::NotRunning
        }
    }

    /// Check BlueALSA daemon status.
    fn check_bluealsa() -> ComponentStatus {
        // Check if bluealsactl exists (indicates BlueALSA is installed)
        let installed = Command::new("which")
            .arg("bluealsactl")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !installed {
            return ComponentStatus::NotInstalled;
        }

        // Check if bluealsa service is running
        let running = Command::new("systemctl")
            .args(["is-active", "--quiet", "bluealsa"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);

        if running {
            ComponentStatus::Ok
        } else {
            ComponentStatus::NotRunning
        }
    }

    /// Attempt to auto-install and configure required components.
    ///
    /// This requires sudo access and only works on Debian/Ubuntu systems.
    /// Returns Ok(()) if setup succeeds, or an error describing what failed.
    pub async fn auto_install() -> Result<()> {
        // Check if we can use apt
        let has_apt = Command::new("which")
            .arg("apt")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !has_apt {
            return Err(BluetoothError::Setup(
                "Auto-install only supports Debian/Ubuntu (apt required)".to_string(),
            ));
        }

        // Install BlueZ if needed
        let status = Self::check();
        if status.bluez == ComponentStatus::NotInstalled {
            tracing::info!("Installing BlueZ...");
            let result = Command::new("sudo")
                .args(["apt", "install", "-y", "bluez"])
                .status();

            if !result.map(|s| s.success()).unwrap_or(false) {
                return Err(BluetoothError::Setup("Failed to install BlueZ".to_string()));
            }
        }

        // Start bluetooth service if not running
        if status.bluez == ComponentStatus::NotRunning {
            tracing::info!("Starting bluetooth service...");
            let result = Command::new("sudo")
                .args(["systemctl", "start", "bluetooth"])
                .status();

            if !result.map(|s| s.success()).unwrap_or(false) {
                return Err(BluetoothError::Setup(
                    "Failed to start bluetooth service".to_string(),
                ));
            }

            // Enable on boot
            let _ = Command::new("sudo")
                .args(["systemctl", "enable", "bluetooth"])
                .status();
        }

        // Install BlueALSA if needed
        if status.bluealsa == ComponentStatus::NotInstalled {
            tracing::info!("Installing BlueALSA...");
            let result = Command::new("sudo")
                .args(["apt", "install", "-y", "bluez-alsa-utils"])
                .status();

            if !result.map(|s| s.success()).unwrap_or(false) {
                return Err(BluetoothError::Setup(
                    "Failed to install BlueALSA".to_string(),
                ));
            }
        }

        // Start BlueALSA service if not running
        if status.bluealsa == ComponentStatus::NotRunning {
            tracing::info!("Starting BlueALSA service...");
            let result = Command::new("sudo")
                .args(["systemctl", "start", "bluealsa"])
                .status();

            if !result.map(|s| s.success()).unwrap_or(false) {
                return Err(BluetoothError::Setup(
                    "Failed to start BlueALSA service".to_string(),
                ));
            }

            // Enable on boot
            let _ = Command::new("sudo")
                .args(["systemctl", "enable", "bluealsa"])
                .status();
        }

        // Verify setup
        let final_status = Self::check();
        if !final_status.ready {
            return Err(BluetoothError::Setup(format!(
                "Setup incomplete: {}",
                final_status.summary()
            )));
        }

        tracing::info!("Bluetooth audio setup complete");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_status_summary() {
        let status = SetupStatus {
            bluez: ComponentStatus::Ok,
            bluealsa: ComponentStatus::Ok,
            issues: vec![],
            ready: true,
        };
        assert!(status.summary().contains("ready"));

        let status = SetupStatus {
            bluez: ComponentStatus::NotInstalled,
            bluealsa: ComponentStatus::Ok,
            issues: vec![SetupIssue {
                description: "BlueZ not installed".to_string(),
                fix_command: Some("sudo apt install bluez".to_string()),
            }],
            ready: false,
        };
        assert!(status.summary().contains("1 issue"));
    }

    #[test]
    fn component_status_equality() {
        assert_eq!(ComponentStatus::Ok, ComponentStatus::Ok);
        assert_ne!(ComponentStatus::Ok, ComponentStatus::NotRunning);
    }
}
