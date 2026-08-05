// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! A channel for communicating with a thread running a PipeWire [loop](crate::loop_).
//!
//! The channel is split into two types, [`Sender`] and [`Receiver`].
//! It can be created using the [`channel`] function.
//! The returned receiver can then be attached to a pipewire loop, and the sender can be used to send messages to
//! the receiver.
//!
//! # Examples
//! This program will print "Hello" three times before terminating, using two threads:
// ignored because https://gitlab.freedesktop.org/pipewire/pipewire-rs/-/issues/19
//! ```no_run
//! use std::{time::Duration, sync::mpsc, thread};
//! use pipewire::main_loop::MainLoopRc;
//!
//! // Our message to the pipewire loop, this tells it to terminate.
//! struct Terminate;
//!
//! fn main() {
//!     let (main_sender, main_receiver) = mpsc::channel();
//!     let (pw_sender, pw_receiver) = pipewire::channel::channel();
//!
//!     let pw_thread = thread::spawn(move || pw_thread(main_sender, pw_receiver));
//!
//!     // Count up to three "Hello"'s.
//!     let mut n = 0;
//!     while n < 3 {
//!         println!("{}", main_receiver.recv().unwrap());
//!         n += 1;
//!     }
//!
//!     // We printed hello 3 times, terminate the pipewire thread now.
//!     pw_sender.send(Terminate);
//!
//!     pw_thread.join();
//! }
//!
//! // This is the code that will run in the pipewire thread.
//! fn pw_thread(
//!     main_sender: mpsc::Sender<String>,
//!     pw_receiver: pipewire::channel::Receiver<Terminate>
//! ) {
//!     let mainloop = MainLoopRc::new(None).expect("Failed to create main loop");
//!
//!     // When we receive a `Terminate` message, quit the main loop.
//!     let _receiver = pw_receiver.attach(mainloop.loop_(), {
//!         let mainloop = mainloop.clone();
//!         move |_| mainloop.quit()
//!     });
//!
//!     // Every 100ms, send `"Hello"` to the main thread.
//!     let timer = mainloop.loop_().add_timer(move |_| {
//!         main_sender.send(String::from("Hello"));
//!     });
//!     timer.update_timer(
//!         Some(Duration::from_millis(1)), // Send the first message immediately
//!         Some(Duration::from_millis(100))
//!     );
//!
//!     mainloop.run();
//! }
//! ```

use std::{
    collections::VecDeque,
    os::unix::prelude::*,
    sync::{Arc, Mutex},
};

use crate::loop_::{IoSource, Loop};
use spa::support::system::IoFlags;

/// A receiver that has not been attached to a loop.
///
/// Use its [`attach`](`Self::attach`) function to receive messages by attaching it to a loop.
pub struct Receiver<T: 'static> {
    channel: Arc<Mutex<Channel<T>>>,
}

impl<T: 'static> Receiver<T> {
    /// Attach the receiver to a loop with a callback.
    ///
    /// This will make the loop call the callback with any messages that get sent to the receiver.
    #[must_use]
    pub fn attach<F>(self, loop_: &Loop, callback: F) -> AttachedReceiver<'_, T>
    where
        F: Fn(T) + 'static,
    {
        let channel = self.channel.clone();
        let readfd = channel
            .lock()
            .expect("Channel mutex lock poisoned")
            .readfd
            .as_raw_fd();

        // Attach the pipe as an IO source to the loop.
        // Whenever the pipe is written to, call the users callback with each message in the queue.
        let iosource = loop_.add_io(readfd, IoFlags::IN, move |_| {
            let mut channel = channel.lock().expect("Channel mutex lock poisoned");

            // Read from the pipe to make it block until written to again.
            let _ = rustix::io::read(&channel.readfd, &mut [0]);

            channel.queue.drain(..).for_each(&callback);
        });

        AttachedReceiver {
            _source: iosource,
            receiver: self,
        }
    }
}

/// A [`Receiver`] that has been attached to a loop.
///
/// Dropping this will cause it to be detached from the loop, so no more messages will be received.
pub struct AttachedReceiver<'l, T>
where
    T: 'static,
{
    _source: IoSource<'l, RawFd>,
    receiver: Receiver<T>,
}

impl<'l, T> AttachedReceiver<'l, T>
where
    T: 'static,
{
    /// Detach the receiver from the loop.
    ///
    /// No more messages will be received until you attach it to a loop again.
    #[must_use]
    pub fn deattach(self) -> Receiver<T> {
        self.receiver
    }
}

/// A `Sender` can be used to send messages to its associated [`Receiver`].
///
/// It can be freely cloned, so you can send messages from multiple  places.
pub struct Sender<T> {
    channel: Arc<Mutex<Channel<T>>>,
}

impl<T> Clone for Sender<T> {
    fn clone(&self) -> Self {
        Self {
            channel: self.channel.clone(),
        }
    }
}

impl<T> Sender<T> {
    /// Send a message to the associated receiver.
    ///
    /// On any errors, this returns the message back to the caller.
    pub fn send(&self, t: T) -> Result<(), T> {
        // Lock the channel.
        let mut channel = match self.channel.lock() {
            Ok(chan) => chan,
            Err(_) => return Err(t),
        };

        // If no messages are waiting already, signal the receiver to read some.
        // Because the channel mutex is locked, it is alright to do this before pushing the message.
        if channel.queue.is_empty() {
            match rustix::io::write(&channel.writefd, &[1u8]) {
                Ok(_) => (),
                Err(_) => return Err(t),
            }
        }

        // Push the new message into the queue.
        channel.queue.push_back(t);

        Ok(())
    }
}

/// Shared state between the [`Sender`]s and the [`Receiver`].
struct Channel<T> {
    /// A pipe used to signal the loop the receiver is attached to that messages are waiting.
    readfd: OwnedFd,
    writefd: OwnedFd,
    /// Queue of any messages waiting to be received.
    queue: VecDeque<T>,
}

/// Create a Sender-Receiver pair, where the sender can be used to send messages to the receiver.
///
/// This functions similar to [`std::sync::mpsc`], but with a receiver that can be attached to any
/// [`Loop`](`crate::loop_::Loop`) to have the loop invoke a callback with any new messages.
///
/// This can be used for inter-thread communication without shared state and where [`std::sync::mpsc`] can not be used
/// because the receiving thread is running the pipewire loop.
pub fn channel<T>() -> (Sender<T>, Receiver<T>)
where
    T: 'static,
{
    let fds = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC).unwrap();

    let channel: Arc<Mutex<Channel<T>>> = Arc::new(Mutex::new(Channel {
        readfd: fds.0,
        writefd: fds.1,
        queue: VecDeque::new(),
    }));

    (
        Sender {
            channel: channel.clone(),
        },
        Receiver { channel },
    )
}
