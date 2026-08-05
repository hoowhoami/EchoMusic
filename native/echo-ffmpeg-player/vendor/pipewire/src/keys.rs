// Copyright The pipewire-rs Contributors.
// SPDX-License-Identifier: MIT

//! A collection of keys that are used to add extra information on objects.
//!
//! ```
//! use pipewire::properties::properties;
//!
//! let props = properties! {
//!   *pipewire::keys::REMOTE_NAME => "pipewire-0"
//! };
//! ```

use std::ffi::CStr;
use std::sync::LazyLock;

// unfortunately we have to take two args as concat_idents! is in experimental
macro_rules! key_constant {
    ($name:ident, $pw_symbol:ident, #[doc = $doc:expr]) => {
        #[doc = $doc]
        pub static $name: LazyLock<&'static str> = LazyLock::new(|| unsafe {
            CStr::from_bytes_with_nul_unchecked($crate::sys::$pw_symbol)
                .to_str()
                .unwrap()
        });
    };
}

key_constant!(PROTOCOL, PW_KEY_PROTOCOL,
    /// protocol used for connection
);
key_constant!(ACCESS, PW_KEY_ACCESS,
    /// how the client access is controlled
);
key_constant!(CLIENT_ACCESS, PW_KEY_CLIENT_ACCESS,
    /// how the client wants to be access controlled Must be obtained from trusted sources by the protocol and placed as read-only properties.
);
key_constant!(SEC_PID, PW_KEY_SEC_PID,
    /// Client pid, set by protocol
);
key_constant!(SEC_UID, PW_KEY_SEC_UID,
    /// Client uid, set by protocol
);
key_constant!(SEC_GID, PW_KEY_SEC_GID,
    /// client gid, set by protocol
);
key_constant!(SEC_LABEL, PW_KEY_SEC_LABEL,
    /// client security label, set by protocol
);
key_constant!(LIBRARY_NAME_SYSTEM, PW_KEY_LIBRARY_NAME_SYSTEM,
    /// name of the system library to use
);
key_constant!(LIBRARY_NAME_LOOP, PW_KEY_LIBRARY_NAME_LOOP,
    /// name of the loop library to use
);
key_constant!(LIBRARY_NAME_DBUS, PW_KEY_LIBRARY_NAME_DBUS,
    /// name of the dbus library to use
);
key_constant!(OBJECT_PATH, PW_KEY_OBJECT_PATH,
    /// unique path to construct the object
);
key_constant!(OBJECT_ID, PW_KEY_OBJECT_ID,
    /// a global object id
);
#[cfg(feature = "v0_3_41")]
key_constant!(OBJECT_SERIAL, PW_KEY_OBJECT_SERIAL,
    /// a 64 bit object serial number. This is a number incremented for each object that is created. The lower 32 bits are guaranteed to never be SPA_ID_INVALID.
);
key_constant!(OBJECT_LINGER, PW_KEY_OBJECT_LINGER,
    /// the object lives on even after the client that created it has been destroyed
);
#[cfg(feature = "v0_3_32")]
key_constant!(OBJECT_REGISTER, PW_KEY_OBJECT_REGISTER,
    /// If the object should be registered.
);
key_constant!(CONFIG_PREFIX, PW_KEY_CONFIG_PREFIX,
    /// a config prefix directory
);
key_constant!(CONFIG_NAME, PW_KEY_CONFIG_NAME,
    /// a config file name
);
#[cfg(feature = "v0_3_57")]
key_constant!(CONFIG_OVERRIDE_PREFIX, PW_KEY_CONFIG_OVERRIDE_PREFIX,
    /// a config override prefix directory
);
#[cfg(feature = "v0_3_57")]
key_constant!(CONFIG_OVERRIDE_NAME, PW_KEY_CONFIG_OVERRIDE_NAME,
    /// a config override file name
);
key_constant!(CONTEXT_PROFILE_MODULES, PW_KEY_CONTEXT_PROFILE_MODULES,
    /// a context profile for modules, deprecated
);
key_constant!(USER_NAME, PW_KEY_USER_NAME,
    /// The user name that runs pipewire
);
key_constant!(HOST_NAME, PW_KEY_HOST_NAME,
    /// The host name of the machine
);
key_constant!(CORE_NAME, PW_KEY_CORE_NAME,
    /// The name of the core. Default is `pipewire-<username>-<pid>`, overwritten by env(PIPEWIRE_CORE)
);
key_constant!(CORE_VERSION, PW_KEY_CORE_VERSION,
    /// The version of the core.
);
key_constant!(CORE_DAEMON, PW_KEY_CORE_DAEMON,
    /// If the core is listening for connections.
);
key_constant!(CORE_ID, PW_KEY_CORE_ID,
    /// the core id
);
key_constant!(CORE_MONITORS, PW_KEY_CORE_MONITORS,
    /// the apis monitored by core.
);
key_constant!(CPU_MAX_ALIGN, PW_KEY_CPU_MAX_ALIGN,
    /// maximum alignment needed to support all CPU optimizations
);
key_constant!(CPU_CORES, PW_KEY_CPU_CORES,
    /// number of cores
);
key_constant!(PRIORITY_SESSION, PW_KEY_PRIORITY_SESSION,
    /// priority in session manager
);
key_constant!(PRIORITY_DRIVER, PW_KEY_PRIORITY_DRIVER,
    /// priority to be a driver
);
key_constant!(REMOTE_NAME, PW_KEY_REMOTE_NAME,
    /// The name of the remote to connect to, default pipewire-0, overwritten by env(PIPEWIRE_REMOTE)
);
key_constant!(REMOTE_INTENTION, PW_KEY_REMOTE_INTENTION,
    /// The intention of the remote connection, "generic", "screencast"
);
key_constant!(APP_NAME, PW_KEY_APP_NAME,
    /// application name. Ex: "Totem Music Player"
);
key_constant!(APP_ID, PW_KEY_APP_ID,
    /// a textual id for identifying an application logically. Ex: "org.gnome.Totem"
);
key_constant!(APP_VERSION, PW_KEY_APP_VERSION,
    /// application version. Ex: "1.2.0"
);
key_constant!(APP_ICON, PW_KEY_APP_ICON,
    /// aa base64 blob with PNG image data
);
key_constant!(APP_ICON_NAME, PW_KEY_APP_ICON_NAME,
    /// an XDG icon name for the application. Ex: "totem"
);
key_constant!(APP_LANGUAGE, PW_KEY_APP_LANGUAGE,
    /// application language if applicable, in standard POSIX format. Ex: "en_GB"
);
key_constant!(APP_PROCESS_ID, PW_KEY_APP_PROCESS_ID,
    /// process id  (pid)
);
key_constant!(APP_PROCESS_BINARY, PW_KEY_APP_PROCESS_BINARY,
    /// binary name
);
key_constant!(APP_PROCESS_USER, PW_KEY_APP_PROCESS_USER,
    /// user name
);
key_constant!(APP_PROCESS_HOST, PW_KEY_APP_PROCESS_HOST,
    /// host name
);
key_constant!(APP_PROCESS_MACHINE_ID, PW_KEY_APP_PROCESS_MACHINE_ID,
    /// the D-Bus host id the application runs on
);
key_constant!(APP_PROCESS_SESSION_ID, PW_KEY_APP_PROCESS_SESSION_ID,
    /// login session of the application, on Unix the value of $XDG_SESSION_ID.
);
key_constant!(WINDOW_X11_DISPLAY, PW_KEY_WINDOW_X11_DISPLAY,
    /// the X11 display string. Ex. ":0.0"
);
key_constant!(CLIENT_ID, PW_KEY_CLIENT_ID,
    /// a client id
);
key_constant!(CLIENT_NAME, PW_KEY_CLIENT_NAME,
    /// the client name
);
key_constant!(CLIENT_API, PW_KEY_CLIENT_API,
    /// the client api used to access PipeWire
);
key_constant!(NODE_ID, PW_KEY_NODE_ID,
    /// node id
);
key_constant!(NODE_NAME, PW_KEY_NODE_NAME,
    /// node name
);
key_constant!(NODE_NICK, PW_KEY_NODE_NICK,
    /// short node name
);
key_constant!(NODE_DESCRIPTION, PW_KEY_NODE_DESCRIPTION,
    /// localized human readable node one-line description. Ex. "Foobar USB Headset"
);
key_constant!(NODE_PLUGGED, PW_KEY_NODE_PLUGGED,
    /// when the node was created. As a uint64 in nanoseconds.
);
key_constant!(NODE_SESSION, PW_KEY_NODE_SESSION,
    /// the session id this node is part of
);
key_constant!(NODE_GROUP, PW_KEY_NODE_GROUP,
    /// the group id this node is part of. Nodes in the same group are always scheduled with the same driver.
);
key_constant!(NODE_EXCLUSIVE, PW_KEY_NODE_EXCLUSIVE,
    /// node wants exclusive access to resources
);
key_constant!(NODE_AUTOCONNECT, PW_KEY_NODE_AUTOCONNECT,
    /// node wants to be automatically connected to a compatible node
);
key_constant!(NODE_LATENCY, PW_KEY_NODE_LATENCY,
    /// the requested latency of the node as a fraction. Ex: 128/48000
);
key_constant!(NODE_MAX_LATENCY, PW_KEY_NODE_MAX_LATENCY,
    /// the maximum supported latency of the node as a fraction. Ex: 1024/48000
);
#[cfg(feature = "v0_3_33")]
key_constant!(NODE_LOCK_QUANTUM, PW_KEY_NODE_LOCK_QUANTUM,
    /// don't change quantum when this node is active
);
#[cfg(feature = "v0_3_45")]
key_constant!(NODE_FORCE_QUANTUM, PW_KEY_NODE_FORCE_QUANTUM,
    /// force a quantum while the node is active
);
#[cfg(feature = "v0_3_33")]
key_constant!(NODE_RATE, PW_KEY_NODE_RATE,
    /// the requested rate of the graph as a fraction. Ex: 1/48000
);
#[cfg(feature = "v0_3_33")]
key_constant!(NODE_LOCK_RATE, PW_KEY_NODE_LOCK_RATE,
    /// don't change rate when this node is active
);
#[cfg(feature = "v0_3_45")]
key_constant!(NODE_FORCE_RATE, PW_KEY_NODE_FORCE_RATE,
    /// force a rate while the node is active
);
key_constant!(NODE_DONT_RECONNECT, PW_KEY_NODE_DONT_RECONNECT,
    /// don't reconnect this node. The node is initially linked to target.object or the default node. If the target is removed, the node is destroyed
);
key_constant!(NODE_ALWAYS_PROCESS, PW_KEY_NODE_ALWAYS_PROCESS,
    /// process even when unlinked
);
#[cfg(feature = "v0_3_33")]
key_constant!(NODE_WANT_DRIVER, PW_KEY_NODE_WANT_DRIVER,
    /// the node wants to be grouped with a driver node in order to schedule the graph.
);
key_constant!(NODE_PAUSE_ON_IDLE, PW_KEY_NODE_PAUSE_ON_IDLE,
    /// pause the node when idle
);
#[cfg(feature = "v0_3_44")]
key_constant!(NODE_SUSPEND_ON_IDLE, PW_KEY_NODE_SUSPEND_ON_IDLE,
    /// suspend the node when idle
);
key_constant!(NODE_CACHE_PARAMS, PW_KEY_NODE_CACHE_PARAMS,
    /// cache the node params
);
#[cfg(feature = "v0_3_44")]
key_constant!(NODE_TRANSPORT_SYNC, PW_KEY_NODE_TRANSPORT_SYNC,
    /// the node handles transport sync
);
key_constant!(NODE_DRIVER, PW_KEY_NODE_DRIVER,
    /// node can drive the graph
);
key_constant!(NODE_STREAM, PW_KEY_NODE_STREAM,
    /// node is a stream, the server side should add a converter
);
key_constant!(NODE_VIRTUAL, PW_KEY_NODE_VIRTUAL,
    /// the node is some sort of virtual object
);
key_constant!(NODE_PASSIVE, PW_KEY_NODE_PASSIVE,
    /// indicate that a node wants passive links on output/input/all ports when the value is "out"/"in"/"true" respectively
);
#[cfg(feature = "v0_3_32")]
key_constant!(NODE_LINK_GROUP, PW_KEY_NODE_LINK_GROUP,
    /// the node is internally linked to nodes with the same link-group
);
#[cfg(feature = "v0_3_39")]
key_constant!(NODE_NETWORK, PW_KEY_NODE_NETWORK,
    /// the node is on a network
);
#[cfg(feature = "v0_3_41")]
key_constant!(NODE_TRIGGER, PW_KEY_NODE_TRIGGER,
    /// the node is not scheduled automatically based on the dependencies in the graph but it will be triggered explicitly.
);
#[cfg(feature = "v0_3_64")]
key_constant!(NODE_CHANNELNAMES, PW_KEY_NODE_CHANNELNAMES,
    /// names of node's channels (unrelated to positions)
);
key_constant!(PORT_ID, PW_KEY_PORT_ID,
    /// port id
);
key_constant!(PORT_NAME, PW_KEY_PORT_NAME,
    /// port name
);
key_constant!(PORT_DIRECTION, PW_KEY_PORT_DIRECTION,
    /// the port direction, one of "in" or "out" or "control" and "notify" for control ports
);
key_constant!(PORT_ALIAS, PW_KEY_PORT_ALIAS,
    /// port alias
);
key_constant!(PORT_PHYSICAL, PW_KEY_PORT_PHYSICAL,
    /// if this is a physical port
);
key_constant!(PORT_TERMINAL, PW_KEY_PORT_TERMINAL,
    /// if this port consumes the data
);
key_constant!(PORT_CONTROL, PW_KEY_PORT_CONTROL,
    /// if this port is a control port
);
key_constant!(PORT_MONITOR, PW_KEY_PORT_MONITOR,
    /// if this port is a monitor port
);
key_constant!(PORT_CACHE_PARAMS, PW_KEY_PORT_CACHE_PARAMS,
    /// cache the node port params
);
key_constant!(PORT_EXTRA, PW_KEY_PORT_EXTRA,
    /// api specific extra port info, API name should be prefixed. "jack:flags:56"
);
key_constant!(LINK_ID, PW_KEY_LINK_ID,
    /// a link id
);
key_constant!(LINK_INPUT_NODE, PW_KEY_LINK_INPUT_NODE,
    /// input node id of a link
);
key_constant!(LINK_INPUT_PORT, PW_KEY_LINK_INPUT_PORT,
    /// input port id of a link
);
key_constant!(LINK_OUTPUT_NODE, PW_KEY_LINK_OUTPUT_NODE,
    /// output node id of a link
);
key_constant!(LINK_OUTPUT_PORT, PW_KEY_LINK_OUTPUT_PORT,
    /// output port id of a link
);
key_constant!(LINK_PASSIVE, PW_KEY_LINK_PASSIVE,
    /// indicate that a link is passive and does not cause the graph to be runnable.
);
key_constant!(LINK_FEEDBACK, PW_KEY_LINK_FEEDBACK,
    /// indicate that a link is a feedback link and the target will receive data in the next cycle
);
key_constant!(DEVICE_ID, PW_KEY_DEVICE_ID,
    /// device id
);
key_constant!(DEVICE_NAME, PW_KEY_DEVICE_NAME,
    /// device name
);
key_constant!(DEVICE_PLUGGED, PW_KEY_DEVICE_PLUGGED,
    /// when the device was created. As a uint64 in nanoseconds.
);
key_constant!(DEVICE_NICK, PW_KEY_DEVICE_NICK,
    /// a short device nickname
);
key_constant!(DEVICE_STRING, PW_KEY_DEVICE_STRING,
    /// device string in the underlying layer's format. Ex. "surround51:0"
);
key_constant!(DEVICE_API, PW_KEY_DEVICE_API,
    /// API this device is accessed with. Ex. "alsa", "v4l2"
);
key_constant!(DEVICE_DESCRIPTION, PW_KEY_DEVICE_DESCRIPTION,
    /// localized human readable device one-line description. Ex. "Foobar USB Headset"
);
key_constant!(DEVICE_BUS_PATH, PW_KEY_DEVICE_BUS_PATH,
    /// bus path to the device in the OS' format. Ex. "pci-0000:00:14.0-usb-0:3.2:1.0"
);
key_constant!(DEVICE_SERIAL, PW_KEY_DEVICE_SERIAL,
    /// Serial number if applicable
);
key_constant!(DEVICE_VENDOR_ID, PW_KEY_DEVICE_VENDOR_ID,
    /// vendor ID if applicable
);
key_constant!(DEVICE_VENDOR_NAME, PW_KEY_DEVICE_VENDOR_NAME,
    /// vendor name if applicable
);
key_constant!(DEVICE_PRODUCT_ID, PW_KEY_DEVICE_PRODUCT_ID,
    /// product ID if applicable
);
key_constant!(DEVICE_PRODUCT_NAME, PW_KEY_DEVICE_PRODUCT_NAME,
    /// product name if applicable
);
key_constant!(DEVICE_CLASS, PW_KEY_DEVICE_CLASS,
    /// device class
);
key_constant!(DEVICE_FORM_FACTOR, PW_KEY_DEVICE_FORM_FACTOR,
    /// form factor if applicable. One of "internal", "speaker", "handset", "tv", "webcam", "microphone", "headset", "headphone", "hands-free", "car", "hifi", "computer", "portable"
);
key_constant!(DEVICE_BUS, PW_KEY_DEVICE_BUS,
    /// bus of the device if applicable. One of "isa", "pci", "usb", "firewire", "bluetooth"
);
key_constant!(DEVICE_SUBSYSTEM, PW_KEY_DEVICE_SUBSYSTEM,
    /// device subsystem
);
#[cfg(feature = "v0_3_53")]
/// device sysfs path
pub static DEVICE_SYSFS_PATH: LazyLock<&'static str> = LazyLock::new(|| "device.sysfs.path");
key_constant!(DEVICE_ICON, PW_KEY_DEVICE_ICON,
    /// icon for the device. A base64 blob containing PNG image data
);
key_constant!(DEVICE_ICON_NAME, PW_KEY_DEVICE_ICON_NAME,
    /// an XDG icon name for the device. Ex. "sound-card-speakers-usb"
);
key_constant!(DEVICE_INTENDED_ROLES, PW_KEY_DEVICE_INTENDED_ROLES,
    /// intended use. A space separated list of roles (see PW_KEY_MEDIA_ROLE) this device is particularly well suited for, due to latency, quality or form factor.
);
key_constant!(DEVICE_CACHE_PARAMS, PW_KEY_DEVICE_CACHE_PARAMS,
    /// cache the device spa params
);
key_constant!(MODULE_ID, PW_KEY_MODULE_ID,
    /// the module id
);
key_constant!(MODULE_NAME, PW_KEY_MODULE_NAME,
    /// the name of the module
);
key_constant!(MODULE_AUTHOR, PW_KEY_MODULE_AUTHOR,
    /// the author's name
);
key_constant!(MODULE_DESCRIPTION, PW_KEY_MODULE_DESCRIPTION,
    /// a human readable one-line description of the module's purpose.
);
key_constant!(MODULE_USAGE, PW_KEY_MODULE_USAGE,
    /// a human readable usage description of the module's arguments.
);
key_constant!(MODULE_VERSION, PW_KEY_MODULE_VERSION,
    /// a version string for the module.
);
key_constant!(FACTORY_ID, PW_KEY_FACTORY_ID,
    /// the factory id
);
key_constant!(FACTORY_NAME, PW_KEY_FACTORY_NAME,
    /// the name of the factory
);
key_constant!(FACTORY_USAGE, PW_KEY_FACTORY_USAGE,
    /// the usage of the factory
);
key_constant!(FACTORY_TYPE_NAME, PW_KEY_FACTORY_TYPE_NAME,
    /// the name of the type created by a factory
);
key_constant!(FACTORY_TYPE_VERSION, PW_KEY_FACTORY_TYPE_VERSION,
    /// the version of the type created by a factory
);
key_constant!(STREAM_IS_LIVE, PW_KEY_STREAM_IS_LIVE,
    /// Indicates that the stream is live.
);
key_constant!(STREAM_LATENCY_MIN, PW_KEY_STREAM_LATENCY_MIN,
    /// The minimum latency of the stream.
);
key_constant!(STREAM_LATENCY_MAX, PW_KEY_STREAM_LATENCY_MAX,
    /// The maximum latency of the stream
);
key_constant!(STREAM_MONITOR, PW_KEY_STREAM_MONITOR,
    /// Indicates that the stream is monitoring and might select a less accurate but faster conversion algorithm.
);
key_constant!(STREAM_DONT_REMIX, PW_KEY_STREAM_DONT_REMIX,
    /// don't remix channels
);
key_constant!(STREAM_CAPTURE_SINK, PW_KEY_STREAM_CAPTURE_SINK,
    /// Try to capture the sink output instead of source output
);
key_constant!(MEDIA_TYPE, PW_KEY_MEDIA_TYPE,
    /// Media type, one of Audio, Video, Midi
);
key_constant!(MEDIA_CATEGORY, PW_KEY_MEDIA_CATEGORY,
    /// Media Category: Playback, Capture, Duplex, Monitor, Manager
);
key_constant!(MEDIA_ROLE, PW_KEY_MEDIA_ROLE,
    /// Role: Movie, Music, Camera, Screen, Communication, Game, Notification, DSP, Production, Accessibility, Test
);
key_constant!(MEDIA_CLASS, PW_KEY_MEDIA_CLASS,
    /// class Ex: "Video/Source"
);
key_constant!(MEDIA_NAME, PW_KEY_MEDIA_NAME,
    /// media name. Ex: "Pink Floyd: Time"
);
key_constant!(MEDIA_TITLE, PW_KEY_MEDIA_TITLE,
    /// title. Ex: "Time"
);
key_constant!(MEDIA_ARTIST, PW_KEY_MEDIA_ARTIST,
    /// artist. Ex: "Pink Floyd"
);
key_constant!(MEDIA_COPYRIGHT, PW_KEY_MEDIA_COPYRIGHT,
    /// copyright string
);
key_constant!(MEDIA_SOFTWARE, PW_KEY_MEDIA_SOFTWARE,
    /// generator software
);
key_constant!(MEDIA_LANGUAGE, PW_KEY_MEDIA_LANGUAGE,
    /// language in POSIX format. Ex: en_GB
);
key_constant!(MEDIA_FILENAME, PW_KEY_MEDIA_FILENAME,
    /// filename
);
key_constant!(MEDIA_ICON, PW_KEY_MEDIA_ICON,
    /// icon for the media, a base64 blob with PNG image data
);
key_constant!(MEDIA_ICON_NAME, PW_KEY_MEDIA_ICON_NAME,
    /// an XDG icon name for the media. Ex: "audio-x-mp3"
);
key_constant!(MEDIA_COMMENT, PW_KEY_MEDIA_COMMENT,
    /// extra comment
);
key_constant!(MEDIA_DATE, PW_KEY_MEDIA_DATE,
    /// date of the media
);
key_constant!(MEDIA_FORMAT, PW_KEY_MEDIA_FORMAT,
    /// format of the media
);
key_constant!(FORMAT_DSP, PW_KEY_FORMAT_DSP,
    /// a dsp format. Ex: "32 bit float mono audio"
);
key_constant!(AUDIO_CHANNEL, PW_KEY_AUDIO_CHANNEL,
    /// an audio channel. Ex: "FL"
);
#[cfg(feature = "v0_3_32")]
key_constant!(AUDIO_RATE, PW_KEY_AUDIO_RATE,
    /// an audio samplerate
);
key_constant!(AUDIO_CHANNELS, PW_KEY_AUDIO_CHANNELS,
    /// number of audio channels
);
key_constant!(AUDIO_FORMAT, PW_KEY_AUDIO_FORMAT,
    /// an audio format. Ex: "S16LE"
);
#[cfg(feature = "v0_3_43")]
key_constant!(AUDIO_ALLOWED_RATES, PW_KEY_AUDIO_ALLOWED_RATES,
    /// a list of allowed samplerates ex. "[ 44100 48000 ]"
);
key_constant!(VIDEO_RATE, PW_KEY_VIDEO_RATE,
    /// a video framerate
);
key_constant!(VIDEO_FORMAT, PW_KEY_VIDEO_FORMAT,
    /// a video format
);
key_constant!(VIDEO_SIZE, PW_KEY_VIDEO_SIZE,
    /// a video size as "\<width\>x\<height\>"
);
#[cfg(feature = "v0_3_44")]
key_constant!(TARGET_OBJECT, PW_KEY_TARGET_OBJECT,
    /// a target object to link to. This can be and object name or object.serial PIPEWIRE_KEYS_H
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert_eq!(*REMOTE_NAME, "remote.name");
    }
}
