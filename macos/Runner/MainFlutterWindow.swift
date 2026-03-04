import Cocoa
import FlutterMacOS
import CoreAudio

class MainFlutterWindow: NSWindow {
  // Keep the channel alive for the lifetime of the window.
  private var audioDeviceChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)

    // Register the native audio-device channel so Dart can resolve the
    // "auto" placeholder to the actual OS default output device.
    let channel = FlutterMethodChannel(
      name: "com.hoowhoami.echomusic/audio_device",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    // No capture list needed – the handler only calls a static method.
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "getDefaultOutputDeviceId":
        result(MainFlutterWindow.defaultOutputDeviceUID())
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    audioDeviceChannel = channel

    super.awakeFromNib()
  }

  // MARK: – CoreAudio helpers

  /// Returns the CoreAudio UID of the current system default output device.
  /// This UID is the same string that libmpv uses as `AudioDevice.name`.
  private static func defaultOutputDeviceUID() -> String? {
    // --- Step 1: get default output device ID ---
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var size     = UInt32(MemoryLayout<AudioDeviceID>.size)
    var hwAddr   = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice,
      mScope:    kAudioObjectPropertyScopeGlobal,
      mElement:  kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject),
      &hwAddr, 0, nil, &size, &deviceID
    ) == noErr, deviceID != kAudioObjectUnknown else { return nil }

    // --- Step 2: fetch the UID string ---
    // CoreAudio returns a +1 retained CFStringRef (an opaque pointer).
    // We receive it as UnsafeRawPointer? to avoid the Optional<CFString>
    // layout warning, then transfer ownership via Unmanaged.fromOpaque.
    var uidPtr: UnsafeRawPointer? = nil
    var uidSize = UInt32(MemoryLayout<UnsafeRawPointer>.size)
    var uidAddr = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyDeviceUID,
      mScope:    kAudioObjectPropertyScopeGlobal,
      mElement:  kAudioObjectPropertyElementMain
    )
    guard AudioObjectGetPropertyData(
      deviceID, &uidAddr, 0, nil, &uidSize, &uidPtr
    ) == noErr, let ptr = uidPtr else { return nil }

    // takeRetainedValue() consumes the +1 retain from CoreAudio.
    let uid = Unmanaged<CFString>.fromOpaque(ptr).takeRetainedValue()
    return uid as String
  }
}
