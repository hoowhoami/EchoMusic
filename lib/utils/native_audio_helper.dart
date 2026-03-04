import 'dart:io';
import 'package:flutter/services.dart';
import 'logger.dart';

/// Queries the OS for the actual default audio output device ID.
///
/// The returned ID matches the [AudioDevice.name] field reported by media_kit /
/// libmpv, so callers can find the matching entry in
/// [Player.state.audioDevices] to resolve the "auto" placeholder.
///
/// Platform details:
///   macOS  – CoreAudio `kAudioDevicePropertyDeviceUID`
///   Windows – MMDevice endpoint ID (`IMMDevice::GetId`)
///   Linux   – PulseAudio / PipeWire default sink name (`pactl info`)
class NativeAudioHelper {
  static const _channel =
      MethodChannel('com.hoowhoami.echomusic/audio_device');

  /// Returns the OS-level default audio output device identifier, or `null`
  /// when the query fails or the platform is unsupported.
  static Future<String?> getDefaultOutputDeviceId() async {
    if (!Platform.isMacOS && !Platform.isWindows && !Platform.isLinux) {
      return null;
    }
    try {
      final result =
          await _channel.invokeMethod<String>('getDefaultOutputDeviceId');
      return result;
    } on PlatformException catch (e) {
      LoggerService.w('[NativeAudioHelper] getDefaultOutputDeviceId failed: $e');
      return null;
    }
  }
}
