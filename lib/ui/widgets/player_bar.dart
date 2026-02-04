import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:just_audio/just_audio.dart';
import 'dart:ui';
import '../../theme/app_theme.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../screens/lyric_page.dart';
import 'cover_image.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final modernTheme = theme.extension<AppModernTheme>()!;

    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;
        if (song == null) return const SizedBox.shrink();

        return ClipRect(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: modernTheme.glassBlur!, sigmaY: modernTheme.glassBlur!),
            child: Container(
              height: 90,
              padding: const EdgeInsets.symmetric(horizontal: 32),
              decoration: BoxDecoration(
                color: modernTheme.playerBarColor,
                border: Border(
                  top: BorderSide(
                    color: modernTheme.dividerColor!,
                    width: 0.8,
                  ),
                ),
              ),
              child: Row(
                children: [
                  // Song Info
                  SizedBox(
                    width: 320,
                    child: InkWell(
                      onTap: () {
                        Navigator.push(
                          context,
                          CupertinoPageRoute(builder: (_) => const LyricPage()),
                        );
                      },
                      borderRadius: BorderRadius.circular(16),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        child: Row(
                          children: [
                            Hero(
                              tag: 'player_cover',
                              child: CoverImage(
                                url: song.cover,
                                width: 56,
                                height: 56,
                                borderRadius: 12,
                                size: 100,
                                showShadow: false,
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    song.name,
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 15,
                                      letterSpacing: -0.3,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    song.singerName,
                                    style: TextStyle(
                                      color: isDark ? Colors.white54 : Colors.black54,
                                      fontSize: 12,
                                      fontWeight: FontWeight.w500,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),

                  // Controls
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            _PlayerIconButton(
                              icon: audioProvider.isShuffle ? CupertinoIcons.shuffle : CupertinoIcons.arrow_right,
                              isSelected: audioProvider.isShuffle,
                              onPressed: audioProvider.toggleShuffle,
                              size: 18,
                            ),
                            const SizedBox(width: 24),
                            _PlayerIconButton(
                              icon: CupertinoIcons.backward_fill,
                              onPressed: audioProvider.previous,
                              size: 24,
                            ),
                            const SizedBox(width: 28),
                            GestureDetector(
                              onTap: audioProvider.togglePlay,
                              child: Container(
                                width: 44,
                                height: 44,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  gradient: LinearGradient(
                                    colors: [theme.colorScheme.primary, theme.colorScheme.secondary],
                                    begin: Alignment.topLeft,
                                    end: Alignment.bottomRight,
                                  ),
                                  boxShadow: [
                                    BoxShadow(
                                      color: theme.colorScheme.primary.withAlpha(80),
                                      blurRadius: 15,
                                      offset: const Offset(0, 5),
                                    ),
                                  ],
                                ),
                                child: Icon(
                                  audioProvider.isPlaying
                                      ? CupertinoIcons.pause_fill
                                      : CupertinoIcons.play_fill,
                                  size: 20,
                                  color: Colors.white,
                                ),
                              ),
                            ),
                            const SizedBox(width: 28),
                            _PlayerIconButton(
                              icon: CupertinoIcons.forward_fill,
                              onPressed: audioProvider.next,
                              size: 24,
                            ),
                            const SizedBox(width: 24),
                            _PlayerIconButton(
                              icon: audioProvider.loopMode == LoopMode.one
                                  ? CupertinoIcons.repeat_1
                                  : CupertinoIcons.repeat,
                              isSelected: audioProvider.loopMode != LoopMode.off,
                              onPressed: audioProvider.toggleLoopMode,
                              size: 18,
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),
                        SizedBox(
                          width: 500,
                          child: StreamBuilder<Duration>(
                            stream: audioProvider.player.positionStream,
                            builder: (context, snapshot) {
                              final position = snapshot.data ?? Duration.zero;
                              final total = audioProvider.player.duration ?? Duration.zero;
                              return ProgressBar(
                                progress: position,
                                total: total,
                                barHeight: 4,
                                baseBarColor: theme.colorScheme.primary.withAlpha(20),
                                progressBarColor: theme.colorScheme.primary,
                                thumbColor: theme.colorScheme.primary,
                                thumbRadius: 6,
                                thumbCanPaintOutsideBar: false,
                                timeLabelLocation: TimeLabelLocation.none,
                                onSeek: (duration) {
                                  audioProvider.player.seek(duration);
                                },
                              );
                            },
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Volume & Extras
                  SizedBox(
                    width: 320,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        _PlayerIconButton(
                          icon: persistenceProvider.isFavorite(song) ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
                          isSelected: persistenceProvider.isFavorite(song),
                          activeColor: Colors.redAccent,
                          onPressed: () => persistenceProvider.toggleFavorite(song),
                          size: 20,
                        ),
                        const SizedBox(width: 20),
                        Icon(CupertinoIcons.speaker_2_fill, size: 16, color: isDark ? Colors.white38 : Colors.black38),
                        const SizedBox(width: 12),
                        SizedBox(
                          width: 100,
                          child: StreamBuilder<double>(
                            stream: audioProvider.player.volumeStream,
                            builder: (context, snapshot) {
                              return SliderTheme(
                                data: theme.sliderTheme.copyWith(
                                  trackHeight: 3,
                                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 5),
                                ),
                                child: Slider(
                                  value: snapshot.data ?? 1.0,
                                  activeColor: theme.colorScheme.primary.withAlpha(200),
                                  onChanged: (value) {
                                    audioProvider.player.setVolume(value);
                                  },
                                ),
                              );
                            },
                          ),
                        ),
                        const SizedBox(width: 20),
                        _PlayerIconButton(
                          icon: CupertinoIcons.list_bullet,
                          onPressed: () {
                            // TODO: Show playlist
                          },
                          size: 20,
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

class _PlayerIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onPressed;
  final double size;
  final bool isSelected;
  final Color? activeColor;

  const _PlayerIconButton({
    required this.icon,
    required this.onPressed,
    this.size = 20,
    this.isSelected = false,
    this.activeColor,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final color = isSelected 
      ? (activeColor ?? (isDark ? Colors.white : Theme.of(context).primaryColor))
      : (isDark ? Colors.white.withAlpha(100) : Colors.black.withAlpha(100));

    return IconButton(
      icon: Icon(icon, size: size, color: color),
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(),
      splashRadius: 24,
    );
  }
}
