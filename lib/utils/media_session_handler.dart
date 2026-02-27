import 'dart:io';
import 'package:audio_service/audio_service.dart';
import 'package:flutter/foundation.dart';
import 'package:smtc_windows/smtc_windows.dart';
import '../models/song.dart';

/// A Media Session Handler implementation that provides unified system media controls
/// across Windows (SMTC), Linux (MPRIS), and macOS (NowPlaying).
///
/// - macOS/iOS/Android: Uses audio_service
/// - Windows: Uses smtc_windows
/// - Linux: Uses audio_service with audio_service_mpris (auto-detected)
class MediaSessionHandler extends BaseAudioHandler with QueueHandler, SeekHandler {
  static MediaSessionHandler? _instance;
  static SMTCWindows? _smtc;
  static bool _smtcInitialized = false;

  // Callbacks
  static VoidCallback? _onPlayAction;
  static VoidCallback? _onPauseAction;
  static VoidCallback? _onNextAction;
  static VoidCallback? _onPreviousAction;
  static Function(Duration)? _onSeekAction;

  static Future<MediaSessionHandler> init({
    required VoidCallback onPlay,
    required VoidCallback onPause,
    required VoidCallback onNext,
    required VoidCallback onPrevious,
    required Function(Duration) onSeek,
  }) async {
    // Store callbacks
    _onPlayAction = onPlay;
    _onPauseAction = onPause;
    _onNextAction = onNext;
    _onPreviousAction = onPrevious;
    _onSeekAction = onSeek;

    if (_instance != null) return _instance!;

    // Windows: Use SMTC
    if (!kIsWeb && Platform.isWindows) {
      await _initWindows();
      _instance = MediaSessionHandler._internal();
      return _instance!;
    }

    // macOS/Linux/iOS/Android: Use audio_service
    // Linux: audio_service_mpris is auto-registered as the platform implementation
    // and requires androidNotificationChannelId for DBus registration
    final handler = await AudioService.init(
      builder: () => MediaSessionHandler._internal(),
      config: const AudioServiceConfig(
        androidNotificationChannelId: 'com.hoowhoami.echomusic.channel.audio',
        androidNotificationChannelName: 'EchoMusic',
        androidNotificationOngoing: false,
        androidStopForegroundOnPause: true,
      ),
    );

    _instance = handler;
    return _instance!;
  }

  static Future<void> _initWindows() async {
    if (_smtcInitialized) return;

    // Initialize the Rust library first
    await SMTCWindows.initialize();
    _smtcInitialized = true;

    _smtc = SMTCWindows(
      config: const SMTCConfig(
        fastForwardEnabled: false,
        rewindEnabled: false,
        prevEnabled: true,
        nextEnabled: true,
        pauseEnabled: true,
        playEnabled: true,
        stopEnabled: true,
      ),
      enabled: true,
    );

    // Listen for button presses
    _smtc!.buttonPressStream.listen((event) {
      switch (event) {
        case PressedButton.play:
          _onPlayAction?.call();
          break;
        case PressedButton.pause:
          _onPauseAction?.call();
          break;
        case PressedButton.next:
          _onNextAction?.call();
          break;
        case PressedButton.previous:
          _onPreviousAction?.call();
          break;
        case PressedButton.stop:
          _onPauseAction?.call();
          break;
        default:
          break;
      }
    });
    // Note: Windows SMTC doesn't support seek from timeline UI directly
    // The timeline is display-only
  }

  MediaSessionHandler._internal();

  @override
  Future<void> play() async => _onPlayAction?.call();

  @override
  Future<void> pause() async => _onPauseAction?.call();

  @override
  Future<void> skipToNext() async => _onNextAction?.call();

  @override
  Future<void> skipToPrevious() async => _onPreviousAction?.call();

  @override
  Future<void> seek(Duration position) async => _onSeekAction?.call(position);

  /// Updates the metadata shown in the system media control center.
  static void updateMetadata(Song? song, Duration? duration) {
    if (song == null) return;

    final dur = duration ?? Duration(seconds: song.duration.toInt());

    // Windows: Use SMTC
    if (!kIsWeb && Platform.isWindows && _smtc != null) {
      _smtc!.updateMetadata(MusicMetadata(
        title: song.name,
        artist: song.singerName,
        album: song.albumName,
        thumbnail: song.cover.isNotEmpty ? song.cover : null,
      ));
      _smtc!.updateTimeline(PlaybackTimeline(
        startTimeMs: 0,
        endTimeMs: dur.inMilliseconds,
        positionMs: 0,
        minSeekTimeMs: 0,
        maxSeekTimeMs: dur.inMilliseconds,
      ));
      return;
    }

    // Other platforms: Use audio_service
    if (_instance == null) return;
    _instance!.mediaItem.add(MediaItem(
      id: song.hash,
      album: song.albumName,
      title: song.name,
      artist: song.singerName,
      artUri: Uri.tryParse(song.cover),
      duration: dur,
    ));
  }

  /// Updates the playback state (playing/paused, position) in the system media control center.
  static void updatePlaybackState(bool isPlaying, Duration position) {
    // Windows: Use SMTC
    if (!kIsWeb && Platform.isWindows && _smtc != null) {
      _smtc!.setPlaybackStatus(
        isPlaying ? PlaybackStatus.playing : PlaybackStatus.paused,
      );
      _smtc!.setPosition(position);
      return;
    }

    // Other platforms: Use audio_service
    if (_instance == null) return;

    _instance!.playbackState.add(PlaybackState(
      controls: [
        MediaControl.skipToPrevious,
        isPlaying ? MediaControl.pause : MediaControl.play,
        MediaControl.stop,
        MediaControl.skipToNext,
      ],
      systemActions: const {
        MediaAction.seek,
        MediaAction.skipToNext,
        MediaAction.skipToPrevious,
      },
      androidCompactActionIndices: const [0, 1, 3],
      playing: isPlaying,
      processingState: AudioProcessingState.ready,
      updatePosition: position,
    ));
  }

  /// Dispose resources
  static void dispose() {
    _smtc?.dispose();
    _smtc = null;
    _instance = null;
  }
}
