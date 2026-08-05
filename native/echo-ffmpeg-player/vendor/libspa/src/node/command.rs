// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use crate::{constants::ID_INVALID, pod::command::CommandError, utils::SpaTypes};

#[derive(Copy, Clone, PartialEq, Eq)]
pub struct NodeCommandId(spa_sys::spa_node_command);

impl NodeCommandId {
    pub const SUSPEND: Self = Self(spa_sys::SPA_NODE_COMMAND_Suspend);
    pub const PAUSE: Self = Self(spa_sys::SPA_NODE_COMMAND_Pause);
    pub const START: Self = Self(spa_sys::SPA_NODE_COMMAND_Start);
    pub const ENABLE: Self = Self(spa_sys::SPA_NODE_COMMAND_Enable);
    pub const DISABLE: Self = Self(spa_sys::SPA_NODE_COMMAND_Disable);
    pub const FLUSH: Self = Self(spa_sys::SPA_NODE_COMMAND_Flush);
    pub const DRAIN: Self = Self(spa_sys::SPA_NODE_COMMAND_Drain);
    pub const MARKER: Self = Self(spa_sys::SPA_NODE_COMMAND_Marker);
    pub const PARAM_BEGIN: Self = Self(spa_sys::SPA_NODE_COMMAND_ParamBegin);
    pub const PARAM_END: Self = Self(spa_sys::SPA_NODE_COMMAND_ParamEnd);
    pub const REQUEST_PROCESS: Self = Self(spa_sys::SPA_NODE_COMMAND_RequestProcess);

    pub fn as_raw(&self) -> spa_sys::spa_node_command {
        self.0
    }

    pub fn from_raw(raw: spa_sys::spa_node_command) -> Self {
        Self(raw)
    }
}

impl std::fmt::Debug for NodeCommandId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let debug_name = unsafe {
            let c_name =
                spa_sys::spa_debug_type_find_name(spa_sys::spa_type_node_command_id, self.as_raw());

            assert!(
                !c_name.is_null(),
                "unknown node command id {}",
                self.as_raw()
            );

            std::ffi::CStr::from_ptr(c_name)
        };

        debug_name.fmt(f)
    }
}

/// Newtype wrapper around [`crate::pod::command::Command`] for node commands.
pub struct NodeCommand(crate::pod::command::Command);

impl NodeCommand {
    pub fn new(id: NodeCommandId) -> Self {
        let raw = unsafe { spa_sys::spa_node_command_init(id.as_raw()) };
        Self(crate::pod::command::Command::from_raw(raw))
    }

    pub fn id(&self) -> NodeCommandId {
        let id = unsafe { spa_sys::spa_node_command_id(self.as_raw_ptr()) };

        assert_ne!(id, ID_INVALID, "node command has unexpected type");

        NodeCommandId::from_raw(id)
    }

    /// # Errors
    ///
    /// This function will return an error if `pod` is not of type [`SpaTypes::CommandNode`][crate::utils::SpaTypes]
    pub fn from_pod(pod: crate::pod::command::Command) -> Result<Self, CommandError> {
        if pod.id(SpaTypes::CommandNode).is_err() {
            Err(CommandError::WrongCommandType)
        } else {
            Ok(Self(pod))
        }
    }
}

impl From<NodeCommandId> for NodeCommand {
    fn from(value: NodeCommandId) -> Self {
        Self::new(value)
    }
}

impl std::ops::Deref for NodeCommand {
    type Target = crate::pod::command::Command;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
