use crate::events::PlayerEvent;
use crate::{emit_event, with_runtime, PlayerRuntime, RuntimeCommand};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use std::cell::Cell;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;

static EVENT_CALLBACK: Mutex<Option<Arc<Mutex<ThreadsafeFunction<PlayerEvent>>>>> =
    Mutex::new(None);
static EVENT_DISPATCHER: Mutex<Option<EventDispatcher>> = Mutex::new(None);
static CORE_DISPATCHER: Mutex<Option<CoreDispatcher>> = Mutex::new(None);
static NEXT_EVENT_ID: AtomicU64 = AtomicU64::new(0);

thread_local! {
    static CORE_DISPATCH_ACTIVE: Cell<bool> = const { Cell::new(false) };
}

enum EventDispatcherMessage {
    Event(PlayerEvent),
    Batch(Vec<PlayerEvent>),
    Shutdown,
}

struct EventDispatcher {
    sender: Sender<EventDispatcherMessage>,
    handle: Option<JoinHandle<()>>,
}

enum CoreDispatcherMessage {
    Command {
        name: &'static str,
        command: RuntimeCommand,
    },
    Shutdown,
}

struct CoreDispatcher {
    sender: Sender<CoreDispatcherMessage>,
    handle: Option<JoinHandle<()>>,
}

pub(crate) fn reset_event_ids() {
    NEXT_EVENT_ID.store(0, Ordering::Release);
}

pub(crate) fn clear_event_callback() {
    if let Ok(mut callback) = EVENT_CALLBACK.lock() {
        *callback = None;
    }
}

pub(crate) fn set_event_callback(callback: ThreadsafeFunction<PlayerEvent>) -> napi::Result<()> {
    *EVENT_CALLBACK.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock event callback: {err}"))
    })? = Some(Arc::new(Mutex::new(callback)));
    Ok(())
}

fn dispatch_event_to_callback(mut event: PlayerEvent) {
    let event_id = NEXT_EVENT_ID.fetch_add(1, Ordering::AcqRel) + 1;
    event = event.with_event_id(event_id);
    if let Ok(guard) = EVENT_CALLBACK.lock() {
        if let Some(callback) = guard.as_ref() {
            if let Ok(callback) = callback.lock() {
                callback.call(Ok(event), ThreadsafeFunctionCallMode::NonBlocking);
            }
        }
    }
}

pub(crate) fn start_event_dispatcher() -> napi::Result<()> {
    let mut guard = EVENT_DISPATCHER.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock event dispatcher: {err}"))
    })?;
    if guard.is_some() {
        return Ok(());
    }

    let (sender, receiver) = channel::<EventDispatcherMessage>();
    let handle = thread::Builder::new()
        .name("player-event-dispatcher".to_string())
        .spawn(move || {
            while let Ok(message) = receiver.recv() {
                match message {
                    EventDispatcherMessage::Event(event) => dispatch_event_to_callback(event),
                    EventDispatcherMessage::Batch(events) => {
                        for event in events {
                            dispatch_event_to_callback(event);
                        }
                    }
                    EventDispatcherMessage::Shutdown => break,
                }
            }
        })
        .map_err(|err| {
            napi::Error::from_reason(format!("failed to spawn event dispatcher: {err}"))
        })?;

    *guard = Some(EventDispatcher {
        sender,
        handle: Some(handle),
    });
    Ok(())
}

pub(crate) fn stop_event_dispatcher() {
    let dispatcher = EVENT_DISPATCHER
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());

    if let Some(mut dispatcher) = dispatcher {
        let _ = dispatcher.sender.send(EventDispatcherMessage::Shutdown);
        if let Some(handle) = dispatcher.handle.take() {
            let _ = handle.join();
        }
    }
}

pub(crate) fn start_core_dispatcher() -> napi::Result<()> {
    let mut guard = CORE_DISPATCHER.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock core dispatcher: {err}"))
    })?;
    if guard.is_some() {
        return Ok(());
    }

    let (sender, receiver) = channel::<CoreDispatcherMessage>();
    let handle = thread::Builder::new()
        .name("player-core-dispatcher".to_string())
        .spawn(move || {
            while let Ok(message) = receiver.recv() {
                match message {
                    CoreDispatcherMessage::Command { name, command } => {
                        let result = crate::RUNTIME.lock();
                        let Ok(mut guard) = result else {
                            emit_event(PlayerEvent::log(
                                "error",
                                format!("core command '{name}' failed: runtime lock poisoned"),
                            ));
                            continue;
                        };
                        let Some(runtime) = guard.as_mut() else {
                            emit_event(PlayerEvent::log(
                                "debug",
                                format!("core command '{name}' ignored: runtime stopped"),
                            ));
                            continue;
                        };
                        CORE_DISPATCH_ACTIVE.set(true);
                        command(runtime);
                        CORE_DISPATCH_ACTIVE.set(false);
                    }
                    CoreDispatcherMessage::Shutdown => break,
                }
            }
        })
        .map_err(|err| {
            napi::Error::from_reason(format!("failed to spawn core dispatcher: {err}"))
        })?;

    *guard = Some(CoreDispatcher {
        sender,
        handle: Some(handle),
    });
    Ok(())
}

pub(crate) fn stop_core_dispatcher() {
    let dispatcher = CORE_DISPATCHER
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());

    if let Some(mut dispatcher) = dispatcher {
        let _ = dispatcher.sender.send(CoreDispatcherMessage::Shutdown);
        if let Some(handle) = dispatcher.handle.take() {
            let _ = handle.join();
        }
    }
}

fn core_sender() -> Option<Sender<CoreDispatcherMessage>> {
    CORE_DISPATCHER
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|dispatcher| dispatcher.sender.clone()))
}

pub(crate) fn dispatch_core_command(name: &'static str, command: RuntimeCommand) {
    let Some(sender) = core_sender() else {
        let _ = with_runtime(|runtime| {
            command(runtime);
            Ok(())
        });
        return;
    };
    let _ = sender.send(CoreDispatcherMessage::Command { name, command });
}

pub(crate) fn call_core_command<T: Send + 'static>(
    name: &'static str,
    command: impl FnOnce(&mut PlayerRuntime) -> napi::Result<T> + Send + 'static,
) -> napi::Result<T> {
    if CORE_DISPATCH_ACTIVE.get() {
        return Err(napi::Error::from_reason(format!(
            "core command '{name}' cannot synchronously dispatch from core dispatcher"
        )));
    }
    let Some(sender) = core_sender() else {
        return with_runtime(command);
    };
    let (reply_tx, reply_rx) = sync_channel(1);
    sender
        .send(CoreDispatcherMessage::Command {
            name,
            command: Box::new(move |runtime| {
                let _ = reply_tx.send(command(runtime));
            }),
        })
        .map_err(|_| napi::Error::from_reason(format!("core command '{name}' dispatch failed")))?;
    reply_rx.recv().map_err(|_| {
        napi::Error::from_reason(format!("core command '{name}' reply channel closed"))
    })?
}

pub(crate) fn send_event(event: PlayerEvent) {
    send_dispatcher_message(EventDispatcherMessage::Event(event));
}

pub(crate) fn send_events(events: Vec<PlayerEvent>) {
    if events.is_empty() {
        return;
    }
    send_dispatcher_message(EventDispatcherMessage::Batch(events));
}

fn send_dispatcher_message(message: EventDispatcherMessage) {
    let sender = EVENT_DISPATCHER
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|dispatcher| dispatcher.sender.clone()));

    let Some(sender) = sender else {
        dispatch_without_thread(message);
        return;
    };

    if let Err(err) = sender.send(message) {
        dispatch_without_thread(err.0);
    }
}

fn dispatch_without_thread(message: EventDispatcherMessage) {
    match message {
        EventDispatcherMessage::Event(event) => dispatch_event_to_callback(event),
        EventDispatcherMessage::Batch(events) => {
            for event in events {
                dispatch_event_to_callback(event);
            }
        }
        EventDispatcherMessage::Shutdown => {}
    }
}
