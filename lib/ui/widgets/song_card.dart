import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import 'cover_image.dart';

class SongCard extends StatelessWidget {
  final Song song;
  final List<Song> playlist;
  final bool showCover;
  final double coverSize;
  final bool showMore;
  final bool isSelected;
  final bool isSelectionMode;
  final ValueChanged<bool>? onSelectionChanged;

  const SongCard({
    super.key,
    required this.song,
    required this.playlist,
    this.showCover = true,
    this.coverSize = 52,
    this.showMore = false,
    this.isSelected = false,
    this.isSelectionMode = false,
    this.onSelectionChanged,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final isCurrent = audioProvider.currentSong?.hash == song.hash;
    final isPlaying = isCurrent && audioProvider.isPlaying;
    final isDark = theme.brightness == Brightness.dark;
    final primaryColor = theme.colorScheme.primary;

    return InkWell(
      onTap: () {
        if (isSelectionMode) {
          onSelectionChanged?.call(!isSelected);
        } else {
          context.read<AudioProvider>().playSong(song, playlist: playlist);
        }
      },
      onLongPress: () {
        onSelectionChanged?.call(!isSelected);
      },
      borderRadius: BorderRadius.circular(16),
      child: Container(
        decoration: isSelectionMode && isSelected
            ? BoxDecoration(
                color: primaryColor.withAlpha(isDark ? 20 : 10),
                borderRadius: BorderRadius.circular(16),
              )
            : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          child: Row(
            children: [
              if (isSelectionMode)
                Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Checkbox(
                    value: isSelected,
                    onChanged: (value) => onSelectionChanged?.call(value ?? false),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                    side: BorderSide(
                      color: isDark ? Colors.white24 : Colors.black26,
                      width: 1.5,
                    ),
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                ),
              if (showCover)
                _buildCover(context, isCurrent, isPlaying, primaryColor),
              const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          song.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: song.isUnavailable
                                ? (isDark ? Colors.white24 : Colors.black26)
                                : (isCurrent ? primaryColor : (isDark ? const Color(0xFFF1F5F9) : const Color(0xFF0F172A))),
                            fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w600,
                            fontSize: 15,
                            letterSpacing: -0.2,
                          ),
                        ),
                      ),
                      if (song.isUnavailable)
                        _buildTag(context, '不可用', const Color(0xFF9CA3AF))
                      else if (song.isPaid)
                        _buildTag(context, '付费', const Color(0xFF8B5CF6))
                      else if (song.isVip)
                        _buildTag(context, 'VIP', const Color(0xFFF59E0B)),
                      if (song.qualityTag.isNotEmpty && !song.isUnavailable)
                        _buildTag(context, song.qualityTag, const Color(0xFF06B6D4)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    song.singerName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: isDark ? Colors.white38 : Colors.black38,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
            if (showMore) ...[
              const SizedBox(width: 24),
              SizedBox(
                width: 180,
                child: Text(
                  song.albumName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: isDark ? Colors.white38 : Colors.black38, 
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              const SizedBox(width: 24),
              Text(
                _formatDuration(song.duration),
                style: TextStyle(
                  color: isDark ? Colors.white30 : Colors.black26, 
                  fontSize: 13,
                  fontFamily: 'monospace',
                ),
              ),
            ],
            const SizedBox(width: 12),
            IconButton(
              icon: const Icon(CupertinoIcons.ellipsis, size: 20),
              onPressed: () {
                // TODO: Context menu
              },
              color: isDark ? Colors.white24 : Colors.black26,
              splashRadius: 24,
            ),
          ],
        ),
      ),
    ),
    );
  }

  Widget _buildCover(BuildContext context, bool isCurrent, bool isPlaying, Color primaryColor) {
    return Stack(
      children: [
        CoverImage(
          url: song.cover,
          width: coverSize,
          height: coverSize,
          borderRadius: 12,
          size: 100,
          showShadow: false,
        ),
        if (isCurrent)
          Container(
            width: coverSize,
            height: coverSize,
            decoration: BoxDecoration(
              color: Colors.black.withAlpha(isPlaying ? 100 : 60),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Center(
              child: isPlaying 
                ? _PlayingIndicator(color: Colors.white)
                : const Icon(CupertinoIcons.play_fill, color: Colors.white, size: 18),
            ),
          ),
      ],
    );
  }

  Widget _buildTag(BuildContext context, String text, Color color) {
    return Container(
      margin: const EdgeInsets.only(left: 8),
      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
      decoration: BoxDecoration(
        color: color.withAlpha(20),
        border: Border.all(color: color.withAlpha(100), width: 0.5),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: color, 
          fontSize: 9, 
          fontWeight: FontWeight.w800,
          letterSpacing: 0.5,
        ),
      ),
    );
  }

  String _formatDuration(int seconds) {
    final m = (seconds / 60).floor();
    final s = seconds % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }
}

class _PlayingIndicator extends StatelessWidget {
  final Color color;
  const _PlayingIndicator({required this.color});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        _bar(8),
        const SizedBox(width: 2),
        _bar(14),
        const SizedBox(width: 2),
        _bar(10),
      ],
    );
  }

  Widget _bar(double height) {
    return Container(
      width: 3,
      height: height,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(1.5),
      ),
    );
  }
}
