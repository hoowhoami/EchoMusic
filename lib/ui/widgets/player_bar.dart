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
    final modernTheme = theme.extension<AppModernTheme>()!;
    final accentColor = theme.colorScheme.primary;

    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;

        return Container(
          height: 80,
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border(
              top: BorderSide(
                color: theme.dividerColor.withAlpha(40),
                width: 0.5,
              ),
            ),
          ),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
                  // 主内容区
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 24),
                    child: song == null
                        ? _buildEmptyState(context, accentColor)
                        : _buildPlayerContent(context, song, audioProvider, persistenceProvider, theme, modernTheme, accentColor),
                  ),

                  // 置顶进度条 - 悬浮在最顶层且增加交互热区
                  if (song != null)
                    Positioned(
                      top: -1, // 向上偏移1像素，覆盖在边框上
                      left: 0,
                      right: 0,
                      child: SizedBox(
                        height: 6, // 增加热区高度以便交互，但视觉上仍保持纤细
                        child: StreamBuilder<Duration>(
                          stream: audioProvider.player.positionStream,
                          builder: (context, snapshot) {
                            final position = snapshot.data ?? Duration.zero;
                            final total = audioProvider.player.duration ?? Duration.zero;
                            return ProgressBar(
                              progress: position,
                              total: total,
                              barHeight: 2.5, // 稍微加粗一点增加可见性
                              baseBarColor: Colors.transparent, 
                              progressBarColor: accentColor.withAlpha(220),
                              thumbColor: accentColor,
                              thumbRadius: 0, // 隐藏滑块
                              onSeek: (duration) => audioProvider.player.seek(duration),
                              timeLabelLocation: TimeLabelLocation.none,
                            );
                          },
                        ),
                      ),
                    ),
                ],
              ),
        );
      },
    );
  }

  Widget _buildEmptyState(BuildContext context, Color accentColor) {
    final theme = Theme.of(context);
    return Row(
      children: [
        // Placeholder Song Info
        SizedBox(
          width: 300,
          child: Row(
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: theme.colorScheme.onSurface.withAlpha(10),
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Icon(CupertinoIcons.music_note, color: theme.colorScheme.onSurface.withAlpha(50)),
              ),
              const SizedBox(width: 14),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(
                    width: 120,
                    height: 14,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.onSurface.withAlpha(10),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Container(
                    width: 80,
                    height: 10,
                    decoration: BoxDecoration(
                      color: theme.colorScheme.onSurface.withAlpha(10),
                      borderRadius: BorderRadius.circular(4),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),

        // Disabled Controls
        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(CupertinoIcons.shuffle, size: 18, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 24),
              Icon(CupertinoIcons.backward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 28),
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: theme.colorScheme.onSurface.withAlpha(5),
                ),
                child: const Center(
                  child: Padding(
                    padding: EdgeInsets.only(left: 4),
                    child: Icon(CupertinoIcons.play_fill, size: 24, color: Colors.grey),
                  ),
                ),
              ),
              const SizedBox(width: 28),
              Icon(CupertinoIcons.forward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 24),
              Icon(CupertinoIcons.repeat, size: 18, color: theme.colorScheme.onSurface.withAlpha(40)),
            ],
          ),
        ),

        // Extras
        SizedBox(
          width: 300,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Icon(CupertinoIcons.heart, size: 20, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 16),
              Icon(CupertinoIcons.speaker_2_fill, size: 14, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 8),
              Container(
                width: 80,
                height: 2,
                decoration: BoxDecoration(
                  color: theme.colorScheme.onSurface.withAlpha(10),
                  borderRadius: BorderRadius.circular(1),
                ),
              ),
              const SizedBox(width: 16),
              _PlayerIconButton(
                icon: CupertinoIcons.list_bullet,
                onPressed: () => _showQueueDrawer(context),
                size: 20,
              ),
            ],
          ),
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
    AppModernTheme modernTheme,
    Color accentColor,
  ) {
    return Row(
      children: [
        // Song Info
        SizedBox(
          width: 300,
          child: InkWell(
            onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const LyricPage())),
            borderRadius: BorderRadius.circular(12),
            child: Row(
              children: [
                Hero(
                  tag: 'player_cover',
                  child: Container(
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(8),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(40),
                          blurRadius: 10,
                          offset: const Offset(0, 4),
                        ),
                      ],
                    ),
                    child: CoverImage(
                      url: song.cover,
                      width: 52,
                      height: 52,
                      borderRadius: 8,
                      size: 100,
                      showShadow: false,
                    ),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        song.name,
                        style: TextStyle(
                          color: theme.colorScheme.onSurface,
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                          letterSpacing: -0.3,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      const SizedBox(height: 2),
                      Text(
                        song.singerName,
                        style: TextStyle(
                          color: theme.colorScheme.onSurface.withAlpha(140),
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
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

        // Controls
        Expanded(
          child: Row(
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
                size: 22,
              ),
              const SizedBox(width: 28),
              _buildPlayButton(theme, audioProvider),
              const SizedBox(width: 28),
              _PlayerIconButton(
                icon: CupertinoIcons.forward_fill,
                onPressed: audioProvider.next,
                size: 22,
              ),
              const SizedBox(width: 24),
              _PlayerIconButton(
                icon: audioProvider.loopMode == LoopMode.one ? CupertinoIcons.repeat_1 : CupertinoIcons.repeat,
                isSelected: audioProvider.loopMode != LoopMode.off,
                onPressed: audioProvider.toggleLoopMode,
                size: 18,
              ),
            ],
          ),
        ),

        // Extras
        SizedBox(
          width: 300,
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
              const SizedBox(width: 12),
              GestureDetector(
                onTap: () => _showPlaybackRateDialog(context, audioProvider),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    border: Border.all(color: theme.colorScheme.onSurface.withAlpha(40)),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    '${audioProvider.playbackRate}x',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.bold,
                      color: theme.colorScheme.onSurface.withAlpha(150),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              _buildVolumeSlider(theme, audioProvider),
              const SizedBox(width: 16),
              _PlayerIconButton(
                icon: CupertinoIcons.list_bullet,
                onPressed: () => _showQueueDrawer(context),
                size: 20,
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildPlayButton(ThemeData theme, AudioProvider audioProvider) {
    return GestureDetector(
      onTap: audioProvider.togglePlay,
      child: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: theme.colorScheme.onSurface.withAlpha(10), // 现代感背景
        ),
        child: Center(
          child: Padding(
            padding: EdgeInsets.only(left: audioProvider.isPlaying ? 0 : 4),
            child: Icon(
              audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
              size: 24,
              color: theme.colorScheme.onSurface,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildVolumeSlider(ThemeData theme, AudioProvider audioProvider) {
    return Row(
      children: [
        Icon(CupertinoIcons.speaker_2_fill, size: 14, color: theme.colorScheme.onSurface.withAlpha(100)),
        const SizedBox(width: 8),
        SizedBox(
          width: 80,
          child: StreamBuilder<double>(
            stream: audioProvider.player.volumeStream,
            builder: (context, snapshot) {
              return SliderTheme(
                data: theme.sliderTheme.copyWith(
                  trackHeight: 2,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 4),
                  activeTrackColor: theme.colorScheme.onSurface.withAlpha(180),
                  inactiveTrackColor: theme.colorScheme.onSurface.withAlpha(30),
                  thumbColor: theme.colorScheme.onSurface,
                ),
                child: Slider(
                  value: snapshot.data ?? 1.0,
                  onChanged: (value) => audioProvider.player.setVolume(value),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  void _showPlaybackRateDialog(BuildContext context, AudioProvider audioProvider) {
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
      barrierLabel: 'QueueDrawer',
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
    final theme = Theme.of(context);
    final color = isSelected 
      ? (activeColor ?? theme.primaryColor)
      : theme.colorScheme.onSurfaceVariant.withAlpha(140);

    return IconButton(
      icon: Icon(icon, size: size, color: color),
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(),
      splashRadius: 24,
    );
  }
}
