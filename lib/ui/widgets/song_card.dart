import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'cover_image.dart';

import '../../models/playlist.dart' as model;

class SongCard extends StatelessWidget {
  final Song song;
  final List<Song> playlist;
  final model.Playlist? parentPlaylist;
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
    this.parentPlaylist,
    this.showCover = true,
    this.coverSize = 52,
    this.showMore = false,
    this.isSelected = false,
    this.isSelectionMode = false,
    this.onSelectionChanged,
  });

  void _showContextMenu(BuildContext context) {
    final userProvider = context.read<UserProvider>();

    final List<PopupMenuItem<String>> menuItems = [
      const PopupMenuItem(
        value: 'play',
        child: Row(
          children: [
            Icon(CupertinoIcons.play_circle, size: 18),
            SizedBox(width: 12),
            Text('立即播放', style: TextStyle(fontSize: 14)),
          ],
        ),
      ),
    ];

    if (userProvider.isAuthenticated) {
      final myPlaylists = userProvider.userPlaylists
          .where((p) => p['list_create_userid'] == userProvider.user?.userid)
          .toList();

      if (myPlaylists.isNotEmpty) {
        menuItems.add(
          PopupMenuItem(
            value: 'addToPlaylist',
            child: PopupMenuButton<int>(
              tooltip: '添加到歌单',
              offset: const Offset(120, 0),
              child: const Row(
                children: [
                  Icon(CupertinoIcons.add_circled, size: 18),
                  SizedBox(width: 12),
                  Text('添加到歌单', style: TextStyle(fontSize: 14)),
                  Spacer(),
                  Icon(CupertinoIcons.chevron_right, size: 12),
                ],
              ),
              onSelected: (listId) async {
                final success = await userProvider.addSongToPlaylist(listId, song);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(success ? '已添加到歌单' : '添加失败')),
                  );
                }
              },
              itemBuilder: (context) => myPlaylists.map((p) {
                return PopupMenuItem<int>(
                  value: p['listid'] ?? p['specialid'],
                  child: Text(p['name'] ?? p['specialname'] ?? ''),
                );
              }).toList(),
            ),
          ),
        );
      }

      if (parentPlaylist != null && userProvider.isCreatedPlaylist(parentPlaylist!.id)) {
        menuItems.add(
          const PopupMenuItem(
            value: 'removeFromPlaylist',
            child: Row(
              children: [
                Icon(CupertinoIcons.trash, size: 18, color: Colors.red),
                SizedBox(width: 12),
                Text('从歌单中删除', style: TextStyle(fontSize: 14, color: Colors.red)),
              ],
            ),
          ),
        );
      }
    }

    final RenderBox button = context.findRenderObject() as RenderBox;
    final RenderBox overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final RelativeRect position = RelativeRect.fromRect(
      Rect.fromPoints(
        button.localToGlobal(Offset.zero, ancestor: overlay),
        button.localToGlobal(button.size.bottomRight(Offset.zero), ancestor: overlay),
      ),
      Offset.zero & overlay.size,
    );

    showMenu(
      context: context,
      position: position,
      items: menuItems,
      elevation: 8,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    ).then((value) async {
      if (value == 'play') {
        context.read<AudioProvider>().playSong(song, playlist: playlist);
      } else if (value == 'removeFromPlaylist') {
        if (parentPlaylist != null) {
          final success = await userProvider.removeSongFromPlaylist(parentPlaylist!.id, song);
          if (context.mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text(success ? '已从歌单删除' : '删除失败')),
            );
          }
        }
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final isCurrent = audioProvider.currentSong?.hash == song.hash;
    final isPlaying = isCurrent && audioProvider.isPlaying;
    final primaryColor = theme.colorScheme.primary;

    return GestureDetector(
      onSecondaryTapDown: (details) => _showContextMenu(context),
      child: InkWell(
        onTap: () {
          if (isSelectionMode) {
            onSelectionChanged?.call(!isSelected);
          } else {
            context.read<AudioProvider>().playSong(song, playlist: playlist);
          }
        },
        onLongPress: () {
          if (isSelectionMode) {
            onSelectionChanged?.call(!isSelected);
          } else {
            _showContextMenu(context);
          }
        },
        borderRadius: BorderRadius.circular(16),
        child: Container(
          decoration: isSelectionMode && isSelected
              ? BoxDecoration(
                  color: primaryColor.withAlpha(20),
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
                        color: theme.colorScheme.outline,
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
                              song.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: song.isUnavailable
                                    ? theme.colorScheme.onSurface.withAlpha(80)
                                    : (isCurrent ? primaryColor : theme.colorScheme.onSurface),
                                fontWeight: isCurrent ? FontWeight.w800 : FontWeight.w700,
                                fontSize: 15,
                                letterSpacing: -0.3,
                              ),
                            ),
                          ),
                          if (song.isUnavailable)
                            _buildTag(context, '不可用', theme.colorScheme.onSurface.withAlpha(100))
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
                          color: theme.colorScheme.onSurfaceVariant,
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
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
                        color: theme.colorScheme.onSurfaceVariant, 
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                  const SizedBox(width: 24),
                  Text(
                    _formatDuration(song.duration),
                    style: TextStyle(
                      color: theme.colorScheme.onSurfaceVariant.withAlpha(150), 
                      fontSize: 13,
                      fontFamily: 'monospace',
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
                const SizedBox(width: 12),
                IconButton(
                  icon: const Icon(CupertinoIcons.ellipsis, size: 20),
                  onPressed: () => _showContextMenu(context),
                  color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                  splashRadius: 24,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildCover(BuildContext context, bool isCurrent, bool isPlaying, Color primaryColor) {
    final theme = Theme.of(context);
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
              color: theme.colorScheme.shadow.withAlpha(isPlaying ? 100 : 60),
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
