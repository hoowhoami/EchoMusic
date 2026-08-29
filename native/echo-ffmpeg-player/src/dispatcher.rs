use crate::events::PlayerEvent;
use crate::{emit_event, with_runtime, PlayerRuntime, RuntimeCommand};
use napi::bindgen_prelude::Unknown;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, sync_channel, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub(crate) type EventCallback =
    ThreadsafeFunction<PlayerEvent, Unknown<'static>, PlayerEvent, Status, true, true, 256>;

static EVENT_CALLBACK: Mutex<Option<Arc<EventCallback>>> = Mutex::new(None);
static EVENT_DISPATCHER: Mutex<Option<EventDispatcher>> = Mutex::new(None);
static CORE_DISPATCHER: Mutex<Option<CoreDispatcher>> = Mutex::new(None);
static NEXT_EVENT_ID: AtomicU64 = AtomicU64::new(0);
static DROPPED_EVENT_COUNT: AtomicU64 = AtomicU64::new(0);
static DROPPED_CRITICAL_EVENT_COUNT: AtomicU64 = AtomicU64::new(0);
static EVENT_DISPATCHER_STOPPING: AtomicBool = AtomicBool::new(false);
const CORE_LOOP_TICK: Duration = Duration::from_millis(250);
const CORE_COMMAND_REPLY_TIMEOUT: Duration = Duration::from_secs(2);
const CORE_BLOCKING_COMMAND_REPLY_TIMEOUT: Duration = Duration::from_secs(5);
const EVENT_QUEUE_CAPACITY: usize = 256;
const CRITICAL_DISPATCH_QUEUE_RETRY_BUDGET: Duration = Duration::from_secs(1);
const CRITICAL_CALLBACK_QUEUE_RETRY_BUDGET: Duration = Duration::from_secs(2);
const EVENT_QUEUE_RETRY_DELAY: Duration = Duration::from_millis(1);

thread_local! {
    static CORE_DISPATCH_ACTIVE: Cell<bool> = const { Cell::new(false) };
}

enum EventDispatcherMessage {
    Event(PlayerEvent),
    Batch(Vec<PlayerEvent>),
    Shutdown,
}

struct EventDispatcher {
    sender: SyncSender<EventDispatcherMessage>,
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
    DROPPED_EVENT_COUNT.store(0, Ordering::Release);
    DROPPED_CRITICAL_EVENT_COUNT.store(0, Ordering::Release);
}

pub(crate) fn clear_event_callback() {
    if let Ok(mut callback) = EVENT_CALLBACK.lock() {
        *callback = None;
    }
}

pub(crate) fn set_event_callback(callback: EventCallback) -> napi::Result<()> {
    *EVENT_CALLBACK.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock event callback: {err}"))
    })? = Some(Arc::new(callback));
    Ok(())
}

fn dispatch_event_to_callback(mut event: PlayerEvent) {
    let dropped_events = DROPPED_EVENT_COUNT.load(Ordering::Acquire);
    if dropped_events > 0 {
        event.dropped_events = Some(dropped_events as f64);
    }
    let dropped_critical_events = DROPPED_CRITICAL_EVENT_COUNT.load(Ordering::Acquire);
    if dropped_critical_events > 0 {
        event.dropped_critical_events = Some(dropped_critical_events as f64);
    }
    let callback = EVENT_CALLBACK
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().cloned());
    if let Some(callback) = callback {
        let droppable = event.is_droppable_when_event_queue_is_full();
        let retry_started = Instant::now();
        loop {
            let status = callback.call(Ok(event.clone()), ThreadsafeFunctionCallMode::NonBlocking);
            if status != Status::QueueFull {
                if status != Status::Ok {
                    record_dropped_events(1, u64::from(!droppable));
                }
                break;
            }
            if !queue_full_retry_allowed(
                droppable,
                callback_is_registered(&callback),
                EVENT_DISPATCHER_STOPPING.load(Ordering::Acquire),
                retry_started.elapsed(),
            ) {
                record_dropped_events(1, u64::from(!droppable));
                break;
            }
            thread::sleep(EVENT_QUEUE_RETRY_DELAY);
        }
    }
}

fn queue_full_retry_allowed(
    droppable: bool,
    callback_registered: bool,
    dispatcher_stopping: bool,
    elapsed: Duration,
) -> bool {
    !droppable
        && callback_registered
        && !dispatcher_stopping
        && elapsed < CRITICAL_CALLBACK_QUEUE_RETRY_BUDGET
}

fn callback_is_registered(callback: &Arc<EventCallback>) -> bool {
    EVENT_CALLBACK.lock().is_ok_and(|guard| {
        guard
            .as_ref()
            .is_some_and(|registered| Arc::ptr_eq(registered, callback))
    })
}

fn dispatch_queue_retry_allowed(dispatcher_stopping: bool, elapsed: Duration) -> bool {
    !dispatcher_stopping && elapsed < CRITICAL_DISPATCH_QUEUE_RETRY_BUDGET
}

pub(crate) fn start_event_dispatcher() -> napi::Result<()> {
    let mut guard = EVENT_DISPATCHER.lock().map_err(|err| {
        napi::Error::from_reason(format!("failed to lock event dispatcher: {err}"))
    })?;
    if guard.is_some() {
        return Ok(());
    }
    EVENT_DISPATCHER_STOPPING.store(false, Ordering::Release);

    let (sender, receiver) = sync_channel::<EventDispatcherMessage>(EVENT_QUEUE_CAPACITY);
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
    EVENT_DISPATCHER_STOPPING.store(true, Ordering::Release);
    let dispatcher = EVENT_DISPATCHER
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());

    if let Some(dispatcher) = dispatcher {
        let EventDispatcher { sender, handle } = dispatcher;
        // Never wait for capacity while the caller may be the JS thread. If the queue is full,
        // dropping the final owned sender lets the receiver exit after draining queued events.
        let _ = sender.try_send(EventDispatcherMessage::Shutdown);
        drop(sender);
        if let Some(handle) = handle {
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
        .spawn(move || loop {
            match receiver.recv_timeout(CORE_LOOP_TICK) {
                Ok(CoreDispatcherMessage::Command { name, command }) => {
                    let mut guard = crate::runtime_guard();
                    let Some(runtime) = guard.as_mut() else {
                        emit_event(PlayerEvent::log(
                            "debug",
                            format!("core command '{name}' ignored: runtime stopped"),
                        ));
                        continue;
                    };
                    CORE_DISPATCH_ACTIVE.set(true);
                    let result = catch_unwind(AssertUnwindSafe(|| command(runtime)));
                    CORE_DISPATCH_ACTIVE.set(false);
                    if let Err(payload) = result {
                        emit_event(PlayerEvent::log(
                            "error",
                            format!(
                                "core command '{name}' panicked: {}",
                                panic_payload_message(payload.as_ref())
                            ),
                        ));
                    }
                }
                Ok(CoreDispatcherMessage::Shutdown) => break,
                Err(RecvTimeoutError::Timeout) => {
                    let mut guard = crate::runtime_guard();
                    let Some(runtime) = guard.as_mut() else {
                        continue;
                    };
                    CORE_DISPATCH_ACTIVE.set(true);
                    let result =
                        catch_unwind(AssertUnwindSafe(|| crate::on_core_loop_tick(runtime)));
                    CORE_DISPATCH_ACTIVE.set(false);
                    if let Err(payload) = result {
                        emit_event(PlayerEvent::log(
                            "error",
                            format!(
                                "core loop tick panicked: {}",
                                panic_payload_message(payload.as_ref())
                            ),
                        ));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
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

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic payload")
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
    let cancelled = Arc::new(AtomicBool::new(false));
    let command_cancelled = cancelled.clone();
    sender
        .send(CoreDispatcherMessage::Command {
            name,
            command: Box::new(move |runtime| {
                if command_cancelled.load(Ordering::Acquire) {
                    return;
                }
                let _ = reply_tx.send(command(runtime));
            }),
        })
        .map_err(|_| napi::Error::from_reason(format!("core command '{name}' dispatch failed")))?;
    match reply_rx.recv_timeout(CORE_COMMAND_REPLY_TIMEOUT) {
        Ok(result) => result,
        Err(err) => {
            cancelled.store(true, Ordering::Release);
            let reason = match err {
                RecvTimeoutError::Timeout => "timed out",
                RecvTimeoutError::Disconnected => "reply channel closed",
            };
            Err(napi::Error::from_reason(format!(
                "core command '{name}' {reason}"
            )))
        }
    }
}

pub(crate) fn call_core_command_blocking<T: Send + 'static>(
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
    let cancelled = Arc::new(AtomicBool::new(false));
    let command_cancelled = cancelled.clone();
    sender
        .send(CoreDispatcherMessage::Command {
            name,
            command: Box::new(move |runtime| {
                if command_cancelled.load(Ordering::Acquire) {
                    return;
                }
                let _ = reply_tx.send(command(runtime));
            }),
        })
        .map_err(|_| napi::Error::from_reason(format!("core command '{name}' dispatch failed")))?;
    match reply_rx.recv_timeout(CORE_BLOCKING_COMMAND_REPLY_TIMEOUT) {
        Ok(result) => result,
        Err(err) => {
            cancelled.store(true, Ordering::Release);
            let reason = match err {
                RecvTimeoutError::Timeout => "timed out",
                RecvTimeoutError::Disconnected => "reply channel closed",
            };
            Err(napi::Error::from_reason(format!(
                "core command '{name}' {reason}"
            )))
        }
    }
}

pub(crate) fn send_event(event: PlayerEvent) {
    send_dispatcher_message(EventDispatcherMessage::Event(assign_event_id(event)));
}

pub(crate) fn send_events(events: Vec<PlayerEvent>) {
    if events.is_empty() {
        return;
    }
    send_dispatcher_message(EventDispatcherMessage::Batch(
        events.into_iter().map(assign_event_id).collect(),
    ));
}

fn assign_event_id(event: PlayerEvent) -> PlayerEvent {
    let event_id = NEXT_EVENT_ID.fetch_add(1, Ordering::AcqRel) + 1;
    event.with_event_id(event_id)
}

fn send_dispatcher_message(message: EventDispatcherMessage) {
    if EVENT_DISPATCHER_STOPPING.load(Ordering::Acquire) {
        record_dropped_message(&message);
        return;
    }
    let sender = EVENT_DISPATCHER
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|dispatcher| dispatcher.sender.clone()));

    let Some(sender) = sender else {
        dispatch_without_thread(message);
        return;
    };

    match sender.try_send(message) {
        Ok(()) => {}
        Err(TrySendError::Full(message)) => {
            let original_count = message_event_count(&message);
            let Some(mut message) = retain_critical_events(message) else {
                record_dropped_events(original_count, 0);
                return;
            };
            let retained_count = message_event_count(&message);
            record_dropped_events(original_count.saturating_sub(retained_count), 0);
            let retry_started = Instant::now();
            loop {
                match sender.try_send(message) {
                    Ok(()) => break,
                    Err(TrySendError::Full(returned)) => {
                        message = returned;
                        if !dispatch_queue_retry_allowed(
                            EVENT_DISPATCHER_STOPPING.load(Ordering::Acquire),
                            retry_started.elapsed(),
                        ) {
                            record_dropped_message(&message);
                            break;
                        }
                        thread::sleep(EVENT_QUEUE_RETRY_DELAY);
                    }
                    Err(TrySendError::Disconnected(returned)) => {
                        if EVENT_DISPATCHER_STOPPING.load(Ordering::Acquire) {
                            record_dropped_message(&returned);
                        } else {
                            dispatch_without_thread(returned);
                        }
                        break;
                    }
                }
            }
        }
        Err(TrySendError::Disconnected(message)) => dispatch_without_thread(message),
    }
}

fn message_event_count(message: &EventDispatcherMessage) -> u64 {
    match message {
        EventDispatcherMessage::Event(_) => 1,
        EventDispatcherMessage::Batch(events) => events.len() as u64,
        EventDispatcherMessage::Shutdown => 0,
    }
}

fn message_critical_event_count(message: &EventDispatcherMessage) -> u64 {
    match message {
        EventDispatcherMessage::Event(event) => {
            u64::from(!event.is_droppable_when_event_queue_is_full())
        }
        EventDispatcherMessage::Batch(events) => events
            .iter()
            .filter(|event| !event.is_droppable_when_event_queue_is_full())
            .count() as u64,
        EventDispatcherMessage::Shutdown => 0,
    }
}

fn record_dropped_message(message: &EventDispatcherMessage) {
    record_dropped_events(
        message_event_count(message),
        message_critical_event_count(message),
    );
}

fn record_dropped_events(count: u64, critical_count: u64) {
    if count > 0 {
        DROPPED_EVENT_COUNT.fetch_add(count, Ordering::AcqRel);
    }
    if critical_count > 0 {
        DROPPED_CRITICAL_EVENT_COUNT.fetch_add(critical_count, Ordering::AcqRel);
    }
}

fn retain_critical_events(message: EventDispatcherMessage) -> Option<EventDispatcherMessage> {
    match message {
        EventDispatcherMessage::Event(event) => (!event.is_droppable_when_event_queue_is_full())
            .then_some(EventDispatcherMessage::Event(event)),
        EventDispatcherMessage::Batch(events) => {
            let events = events
                .into_iter()
                .filter(|event| !event.is_droppable_when_event_queue_is_full())
                .collect::<Vec<_>>();
            (!events.is_empty()).then_some(EventDispatcherMessage::Batch(events))
        }
        EventDispatcherMessage::Shutdown => Some(EventDispatcherMessage::Shutdown),
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

#[cfg(test)]
mod event_queue_tests {
    use super::*;
    use crate::audio_graph::AudioGraphSnapshot;

    #[test]
    fn full_event_queue_drops_only_telemetry() {
        assert!(
            retain_critical_events(EventDispatcherMessage::Event(PlayerEvent::time_update(1.0),))
                .is_none()
        );

        let retained = retain_critical_events(EventDispatcherMessage::Batch(vec![
            PlayerEvent::time_update(1.0),
            PlayerEvent::audio_graph_change(AudioGraphSnapshot::default()),
            PlayerEvent::log("debug", "telemetry".to_string()),
        ]));
        let Some(EventDispatcherMessage::Batch(events)) = retained else {
            panic!("critical event should be retained");
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "audio-graph-change");
    }

    #[test]
    fn queue_full_retry_is_bounded_and_shutdown_aware() {
        assert!(queue_full_retry_allowed(
            false,
            true,
            false,
            CRITICAL_CALLBACK_QUEUE_RETRY_BUDGET - Duration::from_millis(1),
        ));
        assert!(!queue_full_retry_allowed(true, true, false, Duration::ZERO,));
        assert!(!queue_full_retry_allowed(
            false,
            false,
            false,
            Duration::ZERO,
        ));
        assert!(!queue_full_retry_allowed(false, true, true, Duration::ZERO,));
        assert!(!queue_full_retry_allowed(
            false,
            true,
            false,
            CRITICAL_CALLBACK_QUEUE_RETRY_BUDGET,
        ));
        assert!(dispatch_queue_retry_allowed(
            false,
            CRITICAL_DISPATCH_QUEUE_RETRY_BUDGET - Duration::from_millis(1),
        ));
        assert!(!dispatch_queue_retry_allowed(true, Duration::ZERO));
        assert!(!dispatch_queue_retry_allowed(
            false,
            CRITICAL_DISPATCH_QUEUE_RETRY_BUDGET,
        ));
    }

    #[test]
    fn event_queue_counts_messages_for_drop_accounting() {
        assert_eq!(
            message_event_count(&EventDispatcherMessage::Event(PlayerEvent::time_update(
                1.0
            ))),
            1
        );
        assert_eq!(
            message_event_count(&EventDispatcherMessage::Batch(vec![
                PlayerEvent::time_update(1.0),
                PlayerEvent::time_update(2.0),
            ])),
            2
        );
        assert_eq!(message_event_count(&EventDispatcherMessage::Shutdown), 0);
        assert_eq!(
            message_critical_event_count(&EventDispatcherMessage::Batch(vec![
                PlayerEvent::time_update(1.0),
                PlayerEvent::playback_end("eof"),
                PlayerEvent::error(crate::events::PlayerErrorCode::Decode, "failed".to_string()),
            ])),
            2
        );
    }
}
