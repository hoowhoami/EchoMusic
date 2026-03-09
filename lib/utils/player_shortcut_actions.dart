import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/widgets/app_shortcuts.dart';
import 'package:flutter/widgets.dart';
import 'package:provider/provider.dart';

class PlayerShortcutActions {
  static const double _volumeStep = 5.0;

  static Future<void> invoke(BuildContext context, AppShortcutCommand command) {
    switch (command) {
      case AppShortcutCommand.togglePlayback:
        return togglePlayback(context);
      case AppShortcutCommand.previousTrack:
        return previousTrack(context);
      case AppShortcutCommand.nextTrack:
        return nextTrack(context);
      case AppShortcutCommand.volumeUp:
        return increaseVolume(context);
      case AppShortcutCommand.volumeDown:
        return decreaseVolume(context);
      case AppShortcutCommand.toggleMute:
        return toggleMute(context);
      case AppShortcutCommand.toggleFavorite:
        return toggleFavorite(context);
      case AppShortcutCommand.togglePlayMode:
        return togglePlayMode(context);
    }
  }

  static Future<void> togglePlayback(BuildContext context) async {
    final audioProvider = context.read<AudioProvider>();
    if (audioProvider.currentSong == null && !audioProvider.isPlaying) return;
    audioProvider.togglePlay();
  }

  static Future<void> previousTrack(BuildContext context) async {
    context.read<AudioProvider>().previous();
  }

  static Future<void> nextTrack(BuildContext context) async {
    context.read<AudioProvider>().next();
  }

  static Future<void> increaseVolume(BuildContext context) async {
    _adjustVolume(context, _volumeStep);
  }

  static Future<void> decreaseVolume(BuildContext context) async {
    _adjustVolume(context, -_volumeStep);
  }

  static Future<void> toggleMute(BuildContext context) async {
    context.read<AudioProvider>().toggleMute();
  }

  static Future<void> toggleFavorite(BuildContext context) async {
    final audioProvider = context.read<AudioProvider>();
    final currentSong = audioProvider.currentSong;
    if (currentSong == null) return;

    final userProvider = context.read<UserProvider>();
    if (!userProvider.isAuthenticated) return;

    await context.read<PersistenceProvider>().toggleFavorite(
      currentSong,
      userProvider: userProvider,
    );
  }

  static Future<void> togglePlayMode(BuildContext context) async {
    context.read<AudioProvider>().togglePlayMode();
  }

  static void _adjustVolume(BuildContext context, double delta) {
    final audioProvider = context.read<AudioProvider>();
    final currentVolume = audioProvider.player.state.volume;
    final targetVolume = (currentVolume + delta).clamp(0.0, 100.0).toDouble();
    audioProvider.setVolume(targetVolume);
  }
}
