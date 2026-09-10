// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::ptr::addr_of;

use crate::{constants::ID_INVALID, pod::SpaTypes};

#[derive(Debug)]
pub enum CommandError {
    WrongCommandType,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongCommandType => f.write_str("Wrong command type"),
        }
    }
}

impl std::error::Error for CommandError {}

#[repr(transparent)]
pub struct Command(spa_sys::spa_command);

impl Command {
    pub fn into_raw(self) -> spa_sys::spa_command {
        self.0
    }

    pub fn from_raw(raw: spa_sys::spa_command) -> Self {
        Self(raw)
    }

    pub fn as_raw_ptr(&self) -> *mut spa_sys::spa_command {
        addr_of!(self.0).cast_mut()
    }

    pub fn type_(&self) -> SpaTypes {
        unsafe { SpaTypes::from_raw(spa_sys::spa_command_type(self.as_raw_ptr())) }
    }

    pub fn id(&self, type_: SpaTypes) -> Result<u32, CommandError> {
        let id = unsafe { spa_sys::spa_command_id(self.as_raw_ptr(), type_.as_raw()) };

        if id == ID_INVALID {
            Err(CommandError::WrongCommandType)
        } else {
            Ok(id)
        }
    }

    pub fn init(type_: SpaTypes, id: u32) -> Self {
        Self(unsafe { spa_sys::spa_command_init(type_.as_raw(), id) })
    }
}
