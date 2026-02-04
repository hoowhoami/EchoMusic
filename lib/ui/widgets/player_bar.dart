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
import 'package:cached_network_image/cached_network_image.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final modernTheme = Theme.of(context).extension<AppModernTheme>()!;

    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;
        if (song == null) return const SizedBox.shrink();

        return ClipRect(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: modernTheme.glassBlur!, sigmaY: modernTheme.glassBlur!),
            child: Container(
              height: 80,
              padding: const EdgeInsets.symmetric(horizontal: 20),
              decoration: BoxDecoration(
                color: modernTheme.playerBarColor,
                border: Border(
                  top: BorderSide(
                    color: modernTheme.dividerColor!,
                    width: 0.5,
                  ),
                ),
              ),
              child: Row(
                children: [
                  // Song Info
                  SizedBox(
                    width: 280,
                    child: InkWell(
                      onTap: () {
                        Navigator.push(
                          context,
                          CupertinoPageRoute(builder: (_) => const LyricPage()),
                        );
                      },
                      borderRadius: BorderRadius.circular(8),
                      child: Padding(
                        padding: const EdgeInsets.all(8.0),
                        child: Row(
                          children: [
                            Hero(
                              tag: 'player_cover',
                              child: Container(
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(6),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withAlpha(40),
                                      blurRadius: 8,
                                      offset: const Offset(0, 2),
                                    ),
                                  ],
                                ),
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(6),
                                  child: CachedNetworkImage(
                                    imageUrl: song.cover,
                                    width: 48,
                                    height: 48,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    song.name,
                                    style: TextStyle(
                                      fontWeight: FontWeight.w600,
                                      fontSize: 14,
                                      color: isDark ? Colors.white.withAlpha(220) : Colors.black.withAlpha(220),
                                      letterSpacing: -0.2,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    song.singerName,
                                    style: TextStyle(
                                      color: isDark ? Colors.white54 : Colors.black54,
                                      fontSize: 12,
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
                              size: 16,
                            ),
                            const SizedBox(width: 16),
                            _PlayerIconButton(
                              icon: CupertinoIcons.backward_fill,
                              onPressed: audioProvider.previous,
                              size: 22,
                            ),
                            const SizedBox(width: 20),
                            GestureDetector(
                              onTap: audioProvider.togglePlay,
                              child: Container(
                                width: 36,
                                height: 36,
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: isDark ? Colors.white : Colors.black.withAlpha(230),
                                ),
                                child: Icon(
                                  audioProvider.isPlaying
                                      ? CupertinoIcons.pause_fill
                                      : CupertinoIcons.play_fill,
                                  size: 18,
                                  color: isDark ? Colors.black : Colors.white,
                                ),
                              ),
                            ),
                            const SizedBox(width: 20),
                            _PlayerIconButton(
                              icon: CupertinoIcons.forward_fill,
                              onPressed: audioProvider.next,
                              size: 22,
                            ),
                            const SizedBox(width: 16),
                            _PlayerIconButton(
                              icon: audioProvider.loopMode == LoopMode.one
                                  ? CupertinoIcons.repeat_1
                                  : CupertinoIcons.repeat,
                              isSelected: audioProvider.loopMode != LoopMode.off,
                              onPressed: audioProvider.toggleLoopMode,
                              size: 16,
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        SizedBox(
                          width: 460,
                          child: StreamBuilder<Duration>(
                            stream: audioProvider.player.positionStream,
                            builder: (context, snapshot) {
                              final position = snapshot.data ?? Duration.zero;
                              final total = audioProvider.player.duration ?? Duration.zero;
                              return ProgressBar(
                                progress: position,
                                total: total,
                                barHeight: 3,
                                baseBarColor: isDark ? Colors.white.withAlpha(20) : Colors.black.withAlpha(20),
                                progressBarColor: isDark ? Colors.white.withAlpha(200) : Colors.black.withAlpha(200),
                                thumbColor: isDark ? Colors.white : Colors.black,
                                thumbRadius: 4,
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
                    width: 280,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        _PlayerIconButton(
                          icon: persistenceProvider.isFavorite(song) ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
                          isSelected: persistenceProvider.isFavorite(song),
                          activeColor: CupertinoColors.systemRed,
                          onPressed: () => persistenceProvider.toggleFavorite(song),
                          size: 18,
                        ),
                        const SizedBox(width: 12),
                        Icon(CupertinoIcons.volume_down, size: 16, color: isDark ? Colors.white38 : Colors.black38),
                        const SizedBox(width: 8),
                        SizedBox(
                          width: 80,
                          child: StreamBuilder<double>(
                            stream: audioProvider.player.volumeStream,
                            builder: (context, snapshot) {
                              return CupertinoSlider(
                                value: snapshot.data ?? 1.0,
                                activeColor: isDark ? Colors.white70 : Colors.black87,
                                onChanged: (value) {
                                  audioProvider.player.setVolume(value);
                                },
                              );
                            },
                          ),
                        ),
                        const SizedBox(width: 8),
                        Icon(CupertinoIcons.volume_up, size: 16, color: isDark ? Colors.white38 : Colors.black38),
                        const SizedBox(width: 12),
                        _PlayerIconButton(
                          icon: CupertinoIcons.list_bullet,
                          onPressed: () {
                            // TODO: Show playlist
                          },
                          size: 18,
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
      : (isDark ? Colors.white.withAlpha(120) : Colors.black.withAlpha(120));

    return IconButton(
      icon: Icon(icon, size: size, color: color),
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(),
      splashRadius: 20,
    );
  }
}