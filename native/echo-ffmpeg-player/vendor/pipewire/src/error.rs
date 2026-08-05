// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

#[derive(Debug)]
pub enum Error {
    CreationFailed,
    NoMemory,
    WrongProxyType,
    SpaError(spa::utils::result::Error),
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::CreationFailed => None,
            Self::NoMemory => None,
            Self::WrongProxyType => None,
            Self::SpaError(error) => Some(error),
        }
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::CreationFailed => f.write_str("Creation failed"),
            Self::NoMemory => f.write_str("No memory"),
            Self::WrongProxyType => f.write_str("Wrong proxy type"),
            Self::SpaError(error) => write!(f, "{}", error),
        }
    }
}

impl From<spa::utils::result::Error> for Error {
    fn from(value: spa::utils::result::Error) -> Self {
        Self::SpaError(value)
    }
}
