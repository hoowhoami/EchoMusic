// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

use std::mem::MaybeUninit;

use crate::loop_::Loop;

mod box_;
pub use box_::*;
mod rc;
pub use rc::*;

/// A wrapper around the pipewire threaded loop interface. ThreadLoops are a higher level
/// of abstraction around the loop interface. A ThreadLoop can be used to spawn a new thread
/// that runs the wrapped loop.
#[repr(transparent)]
pub struct ThreadLoop(pw_sys::pw_thread_loop);

impl ThreadLoop {
    pub fn as_raw(&self) -> &pw_sys::pw_thread_loop {
        &self.0
    }

    pub fn as_raw_ptr(&self) -> *mut pw_sys::pw_thread_loop {
        std::ptr::addr_of!(self.0).cast_mut()
    }

    pub fn loop_(&self) -> &Loop {
        unsafe {
            let pw_loop = pw_sys::pw_thread_loop_get_loop(self.as_raw_ptr());
            // FIXME: Make sure pw_loop is not null
            &*(pw_loop.cast::<Loop>())
        }
    }

    /// Lock the Loop
    ///
    /// This ensures that the loop thread will not access objects associated
    /// with the loop while the lock is held, `lock()` can be used multiple times
    /// from the same thread.
    ///
    /// The lock needs to be held whenever you call any PipeWire function that
    /// uses an object associated with this loop. Make sure to not hold
    /// on to the lock more than necessary though, as the threaded loop stops
    /// while the lock is held.
    pub fn lock(&self) -> ThreadLoopLockGuard<'_> {
        ThreadLoopLockGuard::new(self)
    }

    /// Start the ThreadLoop
    pub fn start(&self) {
        unsafe {
            pw_sys::pw_thread_loop_start(self.as_raw_ptr());
        }
    }

    /// Stop the ThreadLoop
    ///
    /// Stopping the ThreadLoop must be called without the lock
    pub fn stop(&self) {
        unsafe {
            pw_sys::pw_thread_loop_stop(self.as_raw_ptr());
        }
    }

    /// Signal all threads waiting with [`wait()`](`Self::wait`)
    pub fn signal(&self, signal: bool) {
        unsafe {
            pw_sys::pw_thread_loop_signal(self.as_raw_ptr(), signal);
        }
    }

    /// Release the lock and wait
    ///
    /// Release the lock and wait until some thread calls [`signal()`](`Self::signal`)
    pub fn wait(&self) {
        unsafe {
            pw_sys::pw_thread_loop_wait(self.as_raw_ptr());
        }
    }

    /// Release the lock and wait a maximum of `wait_max_sec` seconds
    /// until some thread calls [`signal()`](`Self::signal`) or time out
    pub fn timed_wait(&self, wait_max_sec: std::time::Duration) {
        unsafe {
            let wait_max_sec: i32 = wait_max_sec
                .as_secs()
                .try_into()
                .expect("Provided timeout does not fit in a i32");
            pw_sys::pw_thread_loop_timed_wait(self.as_raw_ptr(), wait_max_sec);
        }
    }

    /// Get a timespec suitable for [`timed_wait_full()`](`Self::timed_wait_full`)
    pub fn get_time(&self, timeout: i64) -> rustix::time::Timespec {
        unsafe {
            let mut abstime: MaybeUninit<pw_sys::timespec> = std::mem::MaybeUninit::uninit();
            pw_sys::pw_thread_loop_get_time(self.as_raw_ptr(), abstime.as_mut_ptr(), timeout);
            let abstime = abstime.assume_init();
            rustix::time::Timespec {
                tv_sec: abstime.tv_sec as _,
                tv_nsec: abstime.tv_nsec as _,
            }
        }
    }

    /// Release the lock and wait up to abs seconds until some
    /// thread calls [`signal()`](`Self::signal`). Use [`get_time()`](`Self::get_time`)
    /// to get a suitable timespec
    ///
    /// # Panics
    /// Panics if the provided timeout does not fit into a platform timespec
    pub fn timed_wait_full(&self, abstime: rustix::time::Timespec) {
        unsafe {
            // Some 32-bit systems e.g. musl add padding fields for 64-bit time compatibility
            let mut timespec = std::mem::MaybeUninit::<pw_sys::timespec>::zeroed().assume_init();

            #[allow(clippy::useless_conversion)] // Architecture dependent
            {
                timespec.tv_sec = abstime
                    .tv_sec
                    .try_into()
                    .expect("Seconds do not fit into a timespec");
                timespec.tv_nsec = abstime
                    .tv_nsec
                    .try_into()
                    .expect("Nanoseconds do not fit into a timespec");
            }

            pw_sys::pw_thread_loop_timed_wait_full(
                self.as_raw_ptr(),
                &mut timespec as *mut pw_sys::timespec,
            );
        }
    }

    /// Signal all threads executing [`signal()`](`Self::signal`) with `wait_for_accept`
    pub fn accept(&self) {
        unsafe {
            pw_sys::pw_thread_loop_accept(self.as_raw_ptr());
        }
    }

    /// Check if inside the thread
    pub fn in_thread(&self) {
        unsafe {
            pw_sys::pw_thread_loop_in_thread(self.as_raw_ptr());
        }
    }
}

pub struct ThreadLoopLockGuard<'a> {
    thread_loop: &'a ThreadLoop,
}

impl<'a> ThreadLoopLockGuard<'a> {
    fn new(thread_loop: &'a ThreadLoop) -> Self {
        unsafe {
            pw_sys::pw_thread_loop_lock(thread_loop.as_raw_ptr());
        }
        ThreadLoopLockGuard { thread_loop }
    }

    /// Unlock the loop
    ///
    /// Equivalent to dropping the lock guard.
    pub fn unlock(self) {
        drop(self);
    }
}

impl<'a> Drop for ThreadLoopLockGuard<'a> {
    fn drop(&mut self) {
        unsafe {
            pw_sys::pw_thread_loop_unlock(self.thread_loop.as_raw_ptr());
        }
    }
}
