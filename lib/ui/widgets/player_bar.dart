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
import 'queue_drawer.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    final modernTheme = theme.extension<AppModernTheme>()!;
    final accentColor = theme.colorScheme.primary;

    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;

        return ClipRect(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: modernTheme.glassBlur!, sigmaY: modernTheme.glassBlur!),
            child: Container(
              height: 72,
              padding: const EdgeInsets.symmetric(horizontal: 24),
              decoration: BoxDecoration(
                color: modernTheme.playerBarColor,
                border: Border(
                  top: BorderSide(
                    color: modernTheme.dividerColor!,
                    width: 0.8,
                  ),
                ),
              ),
              child: song == null
                  ? _buildEmptyState(context, isDark, accentColor)
                  : _buildPlayerContent(context, song, audioProvider, persistenceProvider, theme, isDark, modernTheme, accentColor),
            ),
          ),
        );
      },
    );
  }

  Widget _buildEmptyState(BuildContext context, bool isDark, Color accentColor) {
    return Row(
      children: [
        Expanded(
          child: Center(
            child: Text(
              '暂无播放内容',
              style: TextStyle(
                color: isDark ? Colors.white.withAlpha(80) : Colors.black.withAlpha(80),
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
            ),
          ),
        ),
        _PlayerIconButton(
          icon: CupertinoIcons.list_bullet,
          onPressed: () => _showQueueDrawer(context),
          size: 20,
        ),
      ],
    );
  }

  Widget _buildPlayerContent(
    BuildContext context,
    dynamic song,
    AudioProvider audioProvider,
    PersistenceProvider persistenceProvider,
    ThemeData theme,
    bool isDark,
    AppModernTheme modernTheme,
    Color accentColor,
  ) {
    return Row(
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
            borderRadius: BorderRadius.circular(12),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  Hero(
                    tag: 'player_cover',
                    child: CoverImage(
                      url: song.cover,
                      width: 48,
                      height: 48,
                      borderRadius: 10,
                      size: 100,
                      showShadow: false,
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
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 14,
                            letterSpacing: -0.3,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          song.singerName,
                          style: TextStyle(
                            color: isDark ? Colors.white54 : Colors.black54,
                            fontSize: 11,
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
          child: Row(
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
                size: 20,
              ),
              const SizedBox(width: 20),
              GestureDetector(
                onTap: audioProvider.togglePlay,
                child: Container(
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      colors: [theme.colorScheme.primary, theme.colorScheme.secondary],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: theme.colorScheme.primary.withAlpha(60),
                        blurRadius: 12,
                        offset: const Offset(0, 4),
                      ),
                    ],
                  ),
                  child: Icon(
                    audioProvider.isPlaying
                        ? CupertinoIcons.pause_fill
                        : CupertinoIcons.play_fill,
                    size: 18,
                    color: Colors.white,
                  ),
                ),
              ),
              const SizedBox(width: 20),
              _PlayerIconButton(
                icon: CupertinoIcons.forward_fill,
                onPressed: audioProvider.next,
                size: 20,
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
              const SizedBox(width: 24),
              SizedBox(
                width: 200,
                child: StreamBuilder<Duration>(
                  stream: audioProvider.player.positionStream,
                  builder: (context, snapshot) {
                    final position = snapshot.data ?? Duration.zero;
                    final total = audioProvider.player.duration ?? Duration.zero;
                    return ProgressBar(
                      progress: position,
                      total: total,
                      barHeight: 3,
                      baseBarColor: theme.colorScheme.primary.withAlpha(20),
                      progressBarColor: theme.colorScheme.primary,
                      thumbColor: theme.colorScheme.primary,
                      thumbRadius: 5,
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
                activeColor: Colors.redAccent,
                onPressed: () => persistenceProvider.toggleFavorite(song),
                size: 18,
              ),
              const SizedBox(width: 12),
              GestureDetector(
                onTap: () => _showPlaybackRateDialog(context, audioProvider),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(8),
                    borderRadius: BorderRadius.circular(5),
                    border: Border.all(
                      color: isDark ? Colors.white.withAlpha(8) : Colors.black.withAlpha(6),
                      width: 0.8,
                    ),
                  ),
                  child: Text(
                    '${audioProvider.playbackRate}x',
                    style: TextStyle(
                      color: accentColor,
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Icon(CupertinoIcons.speaker_2_fill, size: 14, color: isDark ? Colors.white38 : Colors.black38),
              const SizedBox(width: 8),
              SizedBox(
                width: 80,
                child: StreamBuilder<double>(
                  stream: audioProvider.player.volumeStream,
                  builder: (context, snapshot) {
                    return SliderTheme(
                      data: theme.sliderTheme.copyWith(
                        trackHeight: 2.5,
                        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 4),
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
              const SizedBox(width: 8),
              _PlayerIconButton(
                icon: CupertinoIcons.list_bullet,
                onPressed: () => _showQueueDrawer(context),
                size: 18,
              ),
            ],
          ),
        ),
      ],
    );
  }

  void _showPlaybackRateDialog(BuildContext context, AudioProvider audioProvider) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final theme = Theme.of(context);

    showMenu<double>(
      context: context,
      position: RelativeRect.fromLTRB(1000, 100, 0, 0),
      items: [0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map((rate) {
        return PopupMenuItem<double>(
          value: rate,
          child: Row(
            children: [
              Text(
                '${rate}x',
                style: TextStyle(
                  color: audioProvider.playbackRate == rate ? theme.colorScheme.primary : null,
                  fontWeight: audioProvider.playbackRate == rate ? FontWeight.w600 : FontWeight.normal,
                ),
              ),
              if (audioProvider.playbackRate == rate) ...[
                const Spacer(),
                Icon(CupertinoIcons.checkmark_alt, size: 14, color: theme.colorScheme.primary),
              ],
            ],
          ),
          onTap: () {
            audioProvider.setPlaybackRate(rate);
          },
        );
      }).toList(),
    );
  }

  void _showQueueDrawer(BuildContext context) {
    showGeneralDialog(
      context: context,
      barrierColor: Colors.transparent,
      barrierDismissible: true,
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (context, animation, secondaryAnimation) {
        return Align(
          alignment: Alignment.centerRight,
          child: Material(
            elevation: 16,
            borderRadius: const BorderRadius.only(
              topLeft: Radius.circular(16),
            ),
            child: const SizedBox(width: 350, child: QueueDrawer()),
          ),
        );
      },
      transitionBuilder: (context, animation, secondaryAnimation, child) {
        return SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(1, 0),
            end: Offset.zero,
          ).animate(CurvedAnimation(
            parent: animation,
            curve: Curves.easeOutCubic,
          )),
          child: child,
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
