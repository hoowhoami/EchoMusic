// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::thread;

pub fn assert_main_thread() {
    assert_eq!(thread::current().name(), Some("main"));
}
