import 'dart:ui';
import 'package:audio_service/audio_service.dart';
import 'package:flutter/foundation.dart';
import '../models/song.dart';

/// A Media Session Handler implementation using the audio_service package.
/// This provides a unified way to interface with system media controls (SMTC, MPRIS, NowPlaying)
/// across Windows, Linux, and macOS.
class MediaSessionHandler extends BaseAudioHandler with QueueHandler, SeekHandler {
  static MediaSessionHandler? _instance;

  static Future<MediaSessionHandler> init({
    required VoidCallback onPlay,
    required VoidCallback onPause,
    required VoidCallback onNext,
    required VoidCallback onPrevious,
    required Function(Duration) onSeek,
  }) async {
    if (_instance != null) return _instance!;

    final handler = await AudioService.init(
      builder: () => MediaSessionHandler._internal(
        onPlayAction: onPlay,
        onPauseAction: onPause,
        onNextAction: onNext,
        onPreviousAction: onPrevious,
        onSeekAction: onSeek,
      ),
      config: const AudioServiceConfig(
        androidNotificationOngoing: false,
        androidStopForegroundOnPause: true,
      ),
    );
    
    _instance = handler;
    return _instance!;
  }

  final VoidCallback _onPlayAction;
  final VoidCallback _onPauseAction;
  final VoidCallback _onNextAction;
  final VoidCallback _onPreviousAction;
  final Function(Duration) _onSeekAction;

  MediaSessionHandler._internal({
    required VoidCallback onPlayAction,
    required VoidCallback onPauseAction,
    required VoidCallback onNextAction,
    required VoidCallback onPreviousAction,
    required Function(Duration) onSeekAction,
  })  : _onPlayAction = onPlayAction,
        _onPauseAction = onPauseAction,
        _onNextAction = onNextAction,
        _onPreviousAction = onPreviousAction,
        _onSeekAction = onSeekAction;

  @override
  Future<void> play() async => _onPlayAction();

  @override
  Future<void> pause() async => _onPauseAction();

  @override
  Future<void> skipToNext() async => _onNextAction();

  @override
  Future<void> skipToPrevious() async => _onPreviousAction();

  @override
  Future<void> seek(Duration position) async => _onSeekAction(position);

  /// Updates the metadata shown in the system media control center.
  static void updateMetadata(Song? song, Duration? duration) {
    if (_instance == null || song == null) return;

    _instance!.mediaItem.add(MediaItem(
      id: song.hash,
      album: song.albumName,
      title: song.name,
      artist: song.singerName,
      artUri: Uri.tryParse(song.cover),
      duration: duration ?? Duration(seconds: song.duration.toInt()),
    ));
  }

  /// Updates the playback state (playing/paused, position) in the system media control center.
  static void updatePlaybackState(bool isPlaying, Duration position) {
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
}
