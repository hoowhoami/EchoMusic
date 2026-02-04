import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';

class SongCard extends StatelessWidget {
  final Song song;
  final List<Song> playlist;
  final bool showCover;
  final double coverSize;
  final bool showMore;

  const SongCard({
    super.key,
    required this.song,
    required this.playlist,
    this.showCover = true,
    this.coverSize = 48,
    this.showMore = false,
  });

  @override
  Widget build(BuildContext context) {
    final audioProvider = context.watch<AudioProvider>();
    final isPlaying = audioProvider.currentSong?.hash == song.hash && audioProvider.isPlaying;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).colorScheme.primary;

    return InkWell(
      onTap: () {
        context.read<AudioProvider>().playSong(song, playlist: playlist);
      },
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          children: [
            if (showCover)
              _buildCover(context, isPlaying, accentColor),
            const SizedBox(width: 12),
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
                            color: isPlaying ? accentColor : (isDark ? Colors.white : Colors.black),
                            fontWeight: isPlaying ? FontWeight.bold : FontWeight.w500,
                            fontSize: 14,
                          ),
                        ),
                      ),
                      if (song.isVip)
                        _buildTag(context, 'VIP', Colors.orange),
                      if (song.qualityTag.isNotEmpty)
                        _buildTag(context, song.qualityTag, Colors.cyan),
                    ],
                  ),
                  const SizedBox(height: 4),
                  Text(
                    song.singerName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: isDark ? Colors.white38 : Colors.black38,
                      fontSize: 12,
                    ),
                  ),
                ],
              ),
            ),
            if (showMore) ...[
              const SizedBox(width: 20),
              SizedBox(
                width: 150,
                child: Text(
                  song.albumName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 12),
                ),
              ),
              const SizedBox(width: 20),
              Text(
                _formatDuration(song.duration),
                style: TextStyle(color: isDark ? Colors.white24 : Colors.black26, fontSize: 12),
              ),
            ],
            const SizedBox(width: 8),
            IconButton(
              icon: const Icon(CupertinoIcons.ellipsis, size: 18),
              onPressed: () {
                // TODO: Context menu
              },
              color: isDark ? Colors.white24 : Colors.black26,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildCover(BuildContext context, bool isPlaying, Color accentColor) {
    return Container(
      width: coverSize,
      height: coverSize,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(20),
            blurRadius: 8,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Stack(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: CachedNetworkImage(
              imageUrl: song.cover,
              width: coverSize,
              height: coverSize,
              fit: BoxFit.cover,
              errorWidget: (_, __, ___) => const Icon(CupertinoIcons.music_note),
            ),
          ),
          if (isPlaying)
            Container(
              decoration: BoxDecoration(
                color: Colors.black.withAlpha(80),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Center(
                child: _PlayingIndicator(color: accentColor),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTag(BuildContext context, String text, Color color) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
      decoration: BoxDecoration(
        border: Border.all(color: color.withAlpha(100), width: 0.5),
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        text,
        style: TextStyle(color: color, fontSize: 8, fontWeight: FontWeight.bold),
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
      children: List.generate(3, (index) {
        return Container(
          width: 3,
          height: 12,
          margin: const EdgeInsets.symmetric(horizontal: 1),
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        );
      }),
    );
  }
}
