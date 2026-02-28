import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/navigation_provider.dart';
import '../screens/artist_detail_view.dart';
import '../screens/album_detail_view.dart';
import 'cover_image.dart';
import 'custom_toast.dart';
import '../screens/song_detail_view.dart';
import '../screens/song_comment_view.dart';

import '../../models/playlist.dart' as model;

class SongCard extends StatefulWidget {
  final Song song;
  final List<Song> playlist;
  final model.Playlist? parentPlaylist;
  final bool showCover;
  final double coverSize;
  final bool showMore;

  const SongCard({
    super.key,
    required this.song,
    required this.playlist,
    this.parentPlaylist,
    this.showCover = true,
    this.coverSize = 52,
    this.showMore = false,
  });

  @override
  State<SongCard> createState() => _SongCardState();
}

class _SongCardState extends State<SongCard> {
  bool _isMenuOpen = false;

  Future<void> _showContextMenu(BuildContext context, [Offset? tapPosition]) async {
    final userProvider = context.read<UserProvider>();
    final theme = Theme.of(context);

    setState(() => _isMenuOpen = true);

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
      const PopupMenuItem(
        value: 'songDetails',
        child: Row(
          children: [
            Icon(CupertinoIcons.info_circle, size: 18),
            SizedBox(width: 12),
            Text('歌曲详情', style: TextStyle(fontSize: 14)),
          ],
        ),
      ),
      const PopupMenuItem(
        value: 'songComments',
        child: Row(
          children: [
            Icon(CupertinoIcons.chat_bubble_text, size: 18),
            SizedBox(width: 12),
            Text('查看评论', style: TextStyle(fontSize: 14)),
          ],
        ),
      ),
      const PopupMenuItem(
        value: 'artist',
        child: Row(
          children: [
            Icon(CupertinoIcons.person, size: 18),
            SizedBox(width: 12),
            Text('歌手详情', style: TextStyle(fontSize: 14)),
          ],
        ),
      ),
      if (widget.song.albumId != null && widget.song.albumId != '0' && widget.song.albumId!.isNotEmpty)
        const PopupMenuItem(
          value: 'album',
          child: Row(
            children: [
              Icon(CupertinoIcons.music_albums, size: 18),
              SizedBox(width: 12),
              Text('专辑详情', style: TextStyle(fontSize: 14)),
            ],
          ),
        ),
    ];

    if (userProvider.isAuthenticated) {
      final myPlaylists = userProvider.createdPlaylists;

      if (myPlaylists.isNotEmpty) {
        menuItems.add(
          PopupMenuItem(
            value: 'addToPlaylist',
            padding: EdgeInsets.zero,
            enabled: false,
            child: PopupMenuButton<int>(
              tooltip: '',
              offset: const Offset(120, 0),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                child: Row(
                  children: [
                    Icon(CupertinoIcons.add_circled, size: 18, color: theme.colorScheme.onSurface),
                    const SizedBox(width: 12),
                    Text('添加到歌单', style: TextStyle(fontSize: 14, color: theme.colorScheme.onSurface)),
                    const Spacer(),
                    Icon(CupertinoIcons.chevron_right, size: 12, color: theme.colorScheme.onSurface.withAlpha(120)),
                  ],
                ),
              ),
              onSelected: (listId) async {
                Navigator.of(context).pop();
                
                final success = await userProvider.addSongToPlaylist(listId, widget.song);
                if (context.mounted) {
                  if (success) {
                    CustomToast.success(context, '已添加到歌单');
                  } else {
                    CustomToast.error(context, '添加失败');
                  }
                }
              },
              onCanceled: () {
                Navigator.of(context).pop();
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

      if (widget.parentPlaylist != null && userProvider.isCreatedPlaylist(widget.parentPlaylist!.id)) {
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

    final RenderBox overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final RelativeRect position;

    if (tapPosition != null) {
      final Offset localPosition = overlay.globalToLocal(tapPosition);
      position = RelativeRect.fromRect(
        localPosition & Size.zero,
        Offset.zero & overlay.size,
      );
    } else {
      final RenderBox box = context.findRenderObject() as RenderBox;
      final Offset offset = box.localToGlobal(Offset.zero, ancestor: overlay);
      position = RelativeRect.fromRect(
        Rect.fromPoints(
          offset,
          offset.translate(box.size.width, box.size.height),
        ),
        Offset.zero & overlay.size,
      );
    }

    final value = await showMenu(
      context: context,
      position: position,
      items: menuItems,
      elevation: 8,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
    );

    if (mounted) setState(() => _isMenuOpen = false);
    if (value == null || !mounted) return;

    if (value == 'play') {
      if (context.mounted) {
        context.read<AudioProvider>().playSong(widget.song, playlist: widget.playlist);
      }
    } else if (value == 'songDetails') {
      context.read<NavigationProvider>().push(
        SongDetailView(song: widget.song),
        name: 'song_detail',
        arguments: widget.song,
      );
    } else if (value == 'songComments') {
      context.read<NavigationProvider>().push(
        SongCommentView(song: widget.song),
        name: 'song_comment',
        arguments: widget.song,
      );
    } else if (value == 'artist') {
      if (mounted) {
        final artistId = widget.song.singers.isNotEmpty ? widget.song.singers.first.id : 0;
        context.read<NavigationProvider>().push(
          ArtistDetailView(
            artistId: artistId,
            artistName: widget.song.singerName,
          ),
          name: 'artist_detail',
          arguments: {'id': artistId, 'name': widget.song.singerName},
        );
      }
    } else if (value == 'album') {
      if (mounted) {
        final albumId = int.tryParse(widget.song.albumId ?? '0') ?? 0;
        context.read<NavigationProvider>().push(
          AlbumDetailView(
            albumId: albumId,
            albumName: widget.song.albumName,
          ),
          name: 'album_detail',
          arguments: {'id': albumId, 'name': widget.song.albumName},
        );
      }
    } else if (value == 'removeFromPlaylist') {
      if (widget.parentPlaylist != null) {
        final success = await userProvider.removeSongFromPlaylist(widget.parentPlaylist!.id, widget.song);
        if (mounted) {
          if (success) {
            CustomToast.success(this.context, '已从歌单删除');
          } else {
            CustomToast.error(this.context, '删除失败');
          }
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final primaryColor = theme.colorScheme.primary;

    return RepaintBoundary(
      child: Selector<SelectionProvider, ({bool isMode, bool isSelected})>(
        selector: (_, p) => (
          isMode: p.isSelectionMode,
          isSelected: p.isSelected(widget.song.hash),
        ),
        builder: (context, selection, child) {
          final isSelectionMode = selection.isMode;
          final isSelected = selection.isSelected;

          return Selector<AudioProvider, ({bool isCurrent, bool isPlaying})>(
            selector: (_, provider) => (
              isCurrent: provider.currentSong?.isSameSong(widget.song) ?? false,
              isPlaying: provider.isPlaying,
            ),
            builder: (context, playbackState, child) {
              final isCurrent = playbackState.isCurrent;
              final isPlaying = isCurrent && playbackState.isPlaying;

              return Selector<PersistenceProvider, bool>(
                selector: (_, provider) => provider.isFavorite(widget.song),
                builder: (context, isFavorite, child) {
                  return GestureDetector(
                    onSecondaryTapDown: (details) => _showContextMenu(context, details.globalPosition),
                    child: InkWell(
                      onTap: () {
                        if (isSelectionMode) {
                          context.read<SelectionProvider>().toggleSelection(widget.song.hash);
                        } else {
                          context.read<AudioProvider>().playSong(widget.song, playlist: widget.playlist);
                        }
                      },
                      borderRadius: BorderRadius.circular(16),
                      child: Container(
                        decoration: (isSelectionMode && isSelected) || _isMenuOpen
                            ? BoxDecoration(
                                color: primaryColor.withAlpha(_isMenuOpen ? 30 : 20),
                                borderRadius: BorderRadius.circular(16),
                                border: _isMenuOpen ? Border.all(color: primaryColor.withAlpha(80), width: 1.5) : null,
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
                                    onChanged: (value) => context.read<SelectionProvider>().toggleSelection(widget.song.hash),
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                                    side: BorderSide(
                                      color: theme.colorScheme.outline,
                                      width: 1.5,
                                    ),
                                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              if (widget.showCover)
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
                                            widget.song.title,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              color: isCurrent ? primaryColor : theme.colorScheme.onSurface,
                                              fontWeight: isCurrent ? FontWeight.w800 : FontWeight.w700,
                                              fontSize: 15,
                                              letterSpacing: -0.3,
                                            ),
                                          ),
                                        ),
                                        if (isFavorite)
                                          Padding(
                                            padding: const EdgeInsets.only(left: 6),
                                            child: Icon(CupertinoIcons.heart_fill, size: 14, color: Colors.redAccent.withAlpha(200)),
                                          ),
                                        if (widget.song.isPaid)
                                          _buildTag(context, '付费', const Color(0xFF8B5CF6))
                                        else if (widget.song.isVip)
                                          _buildTag(context, 'VIP', const Color(0xFFF59E0B)),
                                        if (widget.song.qualityTag.isNotEmpty)
                                          _buildTag(context, widget.song.qualityTag, const Color(0xFF06B6D4)),
                                      ],
                                    ),
                                    const SizedBox(height: 4),
                                    Text(
                                      widget.song.singerName,
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
                              if (widget.showMore) ...[
                                const SizedBox(width: 24),
                                SizedBox(
                                  width: 180,
                                  child: Text(
                                    widget.song.albumName,
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
                                  _formatDuration(widget.song.duration),
                                  style: TextStyle(
                                    color: theme.colorScheme.onSurfaceVariant.withAlpha(150), 
                                    fontSize: 13,
                                    fontFamily: 'monospace',
                                    fontWeight: FontWeight.w500,
                                  ),
                                ),
                              ],
                              const SizedBox(width: 12),
                              Builder(
                                builder: (buttonContext) => IconButton(
                                  icon: const Icon(CupertinoIcons.ellipsis, size: 20),
                                  onPressed: () => _showContextMenu(buttonContext),
                                  color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                                  splashRadius: 24,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              );
            },
          );
        },
      ),
    );
  }

  Widget _buildCover(BuildContext context, bool isCurrent, bool isPlaying, Color primaryColor) {
    return Stack(
      children: [
        CoverImage(
          url: widget.song.cover,
          width: widget.coverSize,
          height: widget.coverSize,
          borderRadius: 12,
          size: 100,
          showShadow: false,
        ),
        if (isCurrent)
          _PlayingCoverOverlay(
            size: widget.coverSize,
            isPlaying: isPlaying,
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

class _PlayingCoverOverlay extends StatefulWidget {
  final double size;
  final bool isPlaying;

  const _PlayingCoverOverlay({
    required this.size,
    required this.isPlaying,
  });

  @override
  State<_PlayingCoverOverlay> createState() => _PlayingCoverOverlayState();
}

class _PlayingCoverOverlayState extends State<_PlayingCoverOverlay> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _opacityAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1500),
    );
    _opacityAnimation = Tween<double>(begin: 0.4, end: 0.7).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );

    if (widget.isPlaying) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(_PlayingCoverOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isPlaying != oldWidget.isPlaying) {
      if (widget.isPlaying) {
        _controller.repeat(reverse: true);
      } else {
        _controller.stop();
      }
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AnimatedBuilder(
      animation: _opacityAnimation,
      builder: (context, child) {
        return Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: theme.colorScheme.shadow.withValues(alpha: widget.isPlaying ? _opacityAnimation.value : 0.4),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Center(
            child: widget.isPlaying 
              ? const _PlayingIndicator(color: Colors.white)
              : const Icon(CupertinoIcons.play_fill, color: Colors.white, size: 18),
          ),
        );
      },
    );
  }
}

class _PlayingIndicator extends StatefulWidget {
  final Color color;
  const _PlayingIndicator({required this.color});

  @override
  State<_PlayingIndicator> createState() => _PlayingIndicatorState();
}

class _PlayingIndicatorState extends State<_PlayingIndicator> with TickerProviderStateMixin {
  late List<AnimationController> _controllers;
  late List<Animation<double>> _animations;
  final int _barCount = 3;

  @override
  void initState() {
    super.initState();
    _controllers = List.generate(_barCount, (index) {
      return AnimationController(
        vsync: this,
        duration: Duration(milliseconds: 400 + (index * 150)),
      )..repeat(reverse: true);
    });

    _animations = _controllers.map((controller) {
      return Tween<double>(begin: 4.0, end: 16.0).animate(
        CurvedAnimation(parent: controller, curve: Curves.easeInOut),
      );
    }).toList();
  }

  @override
  void dispose() {
    for (var controller in _controllers) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: List.generate(_barCount, (index) {
        return AnimatedBuilder(
          animation: _animations[index],
          builder: (context, child) {
            return Container(
              margin: const EdgeInsets.symmetric(horizontal: 1),
              width: 3,
              height: _animations[index].value,
              decoration: BoxDecoration(
                color: widget.color,
                borderRadius: BorderRadius.circular(1.5),
              ),
            );
          },
        );
      }),
    );
  }
}
