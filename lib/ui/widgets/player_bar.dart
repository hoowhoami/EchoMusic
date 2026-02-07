import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:media_kit/media_kit.dart';
import '../../theme/app_theme.dart';
import '../../providers/audio_provider.dart';
import '../../providers/lyric_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../screens/lyric_page.dart';
import 'cover_image.dart';
import 'queue_drawer.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
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
                color: theme.dividerColor.withAlpha(15),
                width: 0.5,
              ),
            ),
          ),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              // 1. Content Layer
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: song == null
                    ? _buildEmptyState(context, accentColor)
                    : _buildPlayerContent(context, song, audioProvider, persistenceProvider, theme, accentColor),
              ),

              // 2. Redesigned Progress Bar (Top Integrated)
              if (song != null)
                Positioned(
                  top: -10, // Higher positioning for larger hit area
                  left: 0,
                  right: 0,
                  child: _buildIntegratedProgressBar(audioProvider, accentColor, theme),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildIntegratedProgressBar(AudioProvider audioProvider, Color accentColor, ThemeData theme) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: Container(
            height: 20, // Large hit area for easy mouse interaction
            width: double.infinity,
            color: Colors.transparent, // Ensures the entire height is clickable
            child: Stack(
              alignment: Alignment.centerLeft,
              children: [
                // The actual bar
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 0),
                  child: StreamBuilder<Duration>(
                    stream: audioProvider.player.stream.position,
                    builder: (context, snapshot) {
                      final position = snapshot.data ?? Duration.zero;
                      final total = audioProvider.player.state.duration;
                      return ProgressBar(
                        progress: position,
                        total: total,
                        barHeight: 4.0, // Slightly thicker for visibility
                        baseBarColor: theme.colorScheme.onSurface.withAlpha(20),
                        progressBarColor: accentColor,
                        thumbColor: accentColor,
                        thumbRadius: 7.0, // Larger thumb for better control
                        thumbGlowRadius: 15.0,
                        onSeek: (duration) => audioProvider.player.seek(duration),
                        timeLabelLocation: TimeLabelLocation.none,
                      );
                    },
                  ),
                ),
                
                // Climax Bars (Embedded in the bar)
                ...audioProvider.climaxMarks.entries.map((entry) {
                  final start = entry.key;
                  final end = entry.value;
                  final barWidth = (end - start) * constraints.maxWidth;
                  
                  return Positioned(
                    left: constraints.maxWidth * start,
                    child: IgnorePointer(
                      child: Container(
                        width: barWidth.clamp(6.0, constraints.maxWidth), // At least 6px for visibility
                        height: 4,
                        decoration: BoxDecoration(
                          color: Colors.white.withAlpha(160),
                          borderRadius: BorderRadius.circular(2),
                          boxShadow: [
                            BoxShadow(color: accentColor.withAlpha(80), blurRadius: 4),
                          ],
                        ),
                      ),
                    ),
                  );
                }),
              ],
            ),
          ),
        );
      }
    );
  }

  Widget _buildEmptyState(BuildContext context, Color accentColor) {
    final theme = Theme.of(context);
    return Row(
      children: [
        SizedBox(
          width: 300,
          child: Row(
            children: [
              Container(
                width: 52, height: 52,
                decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(8)),
                child: Icon(CupertinoIcons.music_note, color: theme.colorScheme.onSurface.withAlpha(50)),
              ),
              const SizedBox(width: 14),
              Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(width: 120, height: 14, decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(4))),
                  const SizedBox(height: 6),
                  Container(width: 80, height: 10, decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(4))),
                ],
              ),
            ],
          ),
        ),
        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(CupertinoIcons.backward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 28),
              Container(
                width: 44, height: 44,
                decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(5)),
                child: const Center(child: Icon(CupertinoIcons.play_fill, size: 24, color: Colors.grey)),
              ),
              const SizedBox(width: 28),
              Icon(CupertinoIcons.forward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
            ],
          ),
        ),
        const SizedBox(width: 300),
      ],
    );
  }

  Widget _buildPlayerContent(
    BuildContext context,
    dynamic song,
    AudioProvider audioProvider,
    PersistenceProvider persistenceProvider,
    ThemeData theme,
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
                  child: CoverImage(url: song.cover, width: 52, height: 52, borderRadius: 8, size: 100, showShadow: true),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(song.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15), maxLines: 1, overflow: TextOverflow.ellipsis),
                      const SizedBox(height: 2),
                      Text(song.singerName, style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(140), fontSize: 12, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                    ],
                  ),
                ),
                _PlayerIconButton(
                  icon: Icons.lyrics_outlined,
                  onPressed: () => context.read<LyricProvider>().toggleLyricsMode(),
                  size: 18,
                  tooltip: '歌词模式',
                ),
                const SizedBox(width: 8),
              ],
            ),
          ),
        ),

        // Main Controls
        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _PlayerIconButton(icon: CupertinoIcons.backward_fill, onPressed: audioProvider.previous, size: 24),
              const SizedBox(width: 32),
              _buildPlayButton(theme, audioProvider),
              const SizedBox(width: 32),
              _PlayerIconButton(icon: CupertinoIcons.forward_fill, onPressed: audioProvider.next, size: 24),
            ],
          ),
        ),

        // Extras
        SizedBox(
          width: 400,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              StreamBuilder<Duration>(
                stream: audioProvider.player.stream.position,
                builder: (context, snapshot) {
                  final position = snapshot.data ?? Duration.zero;
                  final total = audioProvider.player.state.duration;
                  return Text(
                    '${_formatDuration(position)} / ${_formatDuration(total)}',
                    style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: theme.colorScheme.onSurface.withAlpha(120), fontWeight: FontWeight.w600),
                  );
                },
              ),
              const SizedBox(width: 12),
              _PlayerIconButton(
                icon: audioProvider.loopMode == PlaylistMode.single ? CupertinoIcons.repeat_1 : (audioProvider.loopMode == PlaylistMode.loop ? CupertinoIcons.repeat : CupertinoIcons.shuffle),
                isSelected: true,
                onPressed: audioProvider.toggleLoopMode,
                size: 18,
              ),
              const SizedBox(width: 8),
              _buildVolumeSlider(theme, audioProvider, persistenceProvider),
              const SizedBox(width: 8),
              _PlayerIconButton(
                icon: persistenceProvider.isFavorite(song) ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
                isSelected: persistenceProvider.isFavorite(song),
                activeColor: Colors.redAccent,
                onPressed: () => persistenceProvider.toggleFavorite(song, userProvider: context.read<UserProvider>()),
                size: 20,
              ),
              const SizedBox(width: 8),
              _PlayerIconButton(icon: CupertinoIcons.list_bullet, onPressed: () => _showQueueDrawer(context), size: 20),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildPlayButton(ThemeData theme, AudioProvider audioProvider) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
        child: Container(
          width: 48, height: 48,
          decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(15)),
          child: Center(
            child: audioProvider.isLoading
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                : Padding(
                    // VISUAL CORRECTION: Triangle offset for optical centering
                    padding: EdgeInsets.only(left: audioProvider.isPlaying ? 0 : 4),
                    child: Icon(
                      audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
                      size: 26,
                      color: theme.colorScheme.onSurface,
                    ),
                  ),
          ),
        ),
      ),
    );
  }

  Widget _buildVolumeSlider(ThemeData theme, AudioProvider audioProvider, PersistenceProvider persistenceProvider) {
    return Row(
      children: [
        Icon(CupertinoIcons.speaker_2_fill, size: 14, color: theme.colorScheme.onSurface.withAlpha(100)),
        SizedBox(
          width: 80,
          child: StreamBuilder<double>(
            stream: audioProvider.userVolumeStream,
            initialData: persistenceProvider.volume,
            builder: (context, snapshot) {
              return SliderTheme(
                data: theme.sliderTheme.copyWith(
                  trackHeight: 2,
                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 4),
                  overlayShape: const RoundSliderOverlayShape(overlayRadius: 10),
                ),
                child: Slider(
                  value: snapshot.data ?? 1.0,
                  onChanged: (value) => audioProvider.setVolume(value),
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return "${twoDigits(duration.inMinutes.remainder(60))}:${twoDigits(duration.inSeconds.remainder(60))}";
  }

  void _showQueueDrawer(BuildContext context) {
    showGeneralDialog(
      context: context,
      barrierLabel: 'Queue',
      barrierDismissible: true,
      barrierColor: Colors.black.withAlpha(20),
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (context, _, __) => Align(
        alignment: Alignment.centerRight,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 80),
          child: Material(
            elevation: 20,
            borderRadius: const BorderRadius.horizontal(left: Radius.circular(16)),
            child: SizedBox(width: 380, child: const QueueDrawer()),
          ),
        ),
      ),
      transitionBuilder: (context, anim, _, child) => SlideTransition(
        position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
        child: child,
      ),
    );
  }
}

class _PlayerIconButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback onPressed;
  final double size;
  final bool isSelected;
  final Color? activeColor;
  final String? tooltip;

  const _PlayerIconButton({required this.icon, required this.onPressed, this.size = 20, this.isSelected = false, this.activeColor, this.tooltip});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = isSelected ? (activeColor ?? theme.primaryColor) : theme.colorScheme.onSurfaceVariant.withAlpha(180);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: IconButton(
        icon: Icon(icon, size: size, color: color),
        onPressed: onPressed,
        splashRadius: 24,
        tooltip: tooltip,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(),
      ),
    );
  }
}
