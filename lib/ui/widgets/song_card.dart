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

  SingerInfo? get _primarySinger {
    for (final singer in widget.song.singers) {
      if (singer.id > 0) return singer;
    }
    return widget.song.singers.isNotEmpty ? widget.song.singers.first : null;
  }

  bool get _hasArtistDetail => (_primarySinger?.id ?? 0) > 0;

  int get _albumDetailId => int.tryParse(widget.song.albumId ?? '0') ?? 0;

  bool get _hasAlbumDetail => _albumDetailId > 0 && widget.song.albumName.trim().isNotEmpty;

  void _showUnavailableToast(BuildContext context) {
    CustomToast.error(context, '该歌曲暂无可用音源');
  }

  void _showActionToast({required bool success, required String successMessage, required String failureMessage}) {
    if (success) {
      CustomToast.success(context, successMessage);
    } else {
      CustomToast.error(context, failureMessage);
    }
  }

  void _openArtistDetail() {
    final singer = _primarySinger;
    if (singer == null || singer.id <= 0) {
      CustomToast.error(context, '暂无歌手信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute('artist_detail', id: singer.id)) {
      return;
    }
    context.read<NavigationProvider>().push(
      ArtistDetailView(
        artistId: singer.id,
        artistName: singer.name,
      ),
      name: 'artist_detail',
      arguments: {'id': singer.id, 'name': singer.name},
    );
  }

  void _openAlbumDetail() {
    if (!_hasAlbumDetail) {
      CustomToast.error(context, '暂无专辑信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute('album_detail', id: _albumDetailId)) {
      return;
    }
    context.read<NavigationProvider>().push(
      AlbumDetailView(
        albumId: _albumDetailId,
        albumName: widget.song.albumName,
      ),
      name: 'album_detail',
      arguments: {'id': _albumDetailId, 'name': widget.song.albumName},
    );
  }

  Widget _buildLinkText({
    required String text,
    required TextStyle style,
    required VoidCallback? onTap,
  }) {
    final child = Text(
      text,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: onTap == null
          ? style
          : style.copyWith(
              decoration: TextDecoration.underline,
              decorationColor: style.color,
            ),
    );

    if (onTap == null) return child;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: child,
      ),
    );
  }

  Future<void> _showContextMenu([Offset? tapPosition]) async {
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
                if (!mounted) return;
                _showActionToast(success: success, successMessage: '已添加到歌单', failureMessage: '添加失败');
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
    );

    if (mounted) setState(() => _isMenuOpen = false);
    if (value == null || !mounted) return;

    if (value == 'play') {
      if (!widget.song.isPlayable) {
        _showUnavailableToast(context);
        return;
      }
      context.read<AudioProvider>().playSong(widget.song, playlist: widget.playlist);
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
    } else if (value == 'removeFromPlaylist') {
      if (widget.parentPlaylist != null) {
        final success = await userProvider.removeSongFromPlaylist(widget.parentPlaylist!.id, widget.song);
        if (!mounted) return;
        _showActionToast(success: success, successMessage: '已从歌单删除', failureMessage: '删除失败');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final primaryColor = theme.colorScheme.primary;
    final isCurrentArtistDetail = context.select<NavigationProvider, bool>(
      (provider) => provider.isCurrentRoute('artist_detail', id: _primarySinger?.id),
    );
    final isCurrentAlbumDetail = context.select<NavigationProvider, bool>(
      (provider) => provider.isCurrentRoute('album_detail', id: _albumDetailId),
    );

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
              final isPlayable = widget.song.isPlayable;
              final contentOpacity = isPlayable ? 1.0 : 0.45;

              return Selector<PersistenceProvider, bool>(
                selector: (_, provider) => provider.isFavorite(widget.song),
                builder: (context, isFavorite, child) {
                  return GestureDetector(
                    onSecondaryTapDown: (details) => _showContextMenu(details.globalPosition),
                    child: InkWell(
                      onTap: () {
                        if (isSelectionMode) {
                          context.read<SelectionProvider>().toggleSelection(widget.song.hash);
                        } else if (!isPlayable) {
                          _showUnavailableToast(context);
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
                                Opacity(
                                  opacity: contentOpacity,
                                  child: _buildCover(context, isCurrent, isPlaying, primaryColor),
                                ),
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
                                              color: isCurrent
                                                  ? primaryColor.withAlpha(isPlayable ? 255 : 170)
                                                  : theme.colorScheme.onSurface.withAlpha(isPlayable ? 255 : 140),
                                              fontWeight: isCurrent ? FontWeight.w800 : FontWeight.w700,
                                              fontSize: 15,
                                              letterSpacing: -0.3,
                                            ),
                                          ),
                                        ),
                                        if (isFavorite)
                                          Padding(
                                            padding: const EdgeInsets.only(left: 6),
                                            child: Icon(CupertinoIcons.heart_fill, size: 14, color: Colors.redAccent.withAlpha(isPlayable ? 200 : 120)),
                                          ),
                                        if (!isPlayable)
                                          _buildTag(context, '无音源', theme.colorScheme.outline),
                                        if (widget.song.isPaid)
                                          _buildTag(context, '付费', const Color(0xFF8B5CF6))
                                        else if (widget.song.isVip)
                                          _buildTag(context, 'VIP', const Color(0xFFF59E0B)),
                                        if (widget.song.qualityTag.isNotEmpty)
                                          _buildTag(context, widget.song.qualityTag, const Color(0xFF06B6D4)),
                                      ],
                                    ),
                                    const SizedBox(height: 4),
                                    _buildLinkText(
                                      text: widget.song.singerName,
                                      onTap: !isSelectionMode && _hasArtistDetail && !isCurrentArtistDetail ? _openArtistDetail : null,
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 255 : 140),
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
                                  child: _buildLinkText(
                                    text: widget.song.albumName,
                                    onTap: !isSelectionMode && _hasAlbumDetail && !isCurrentAlbumDetail ? _openAlbumDetail : null,
                                    style: TextStyle(
                                      color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 255 : 140), 
                                      fontSize: 13,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 24),
                                Text(
                                  _formatDuration(widget.song.duration),
                                  style: TextStyle(
                                    color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 150 : 100), 
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
                                  onPressed: _showContextMenu,
                                  color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 180 : 120),
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
            shadowColor: Theme.of(context).colorScheme.shadow,
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

class _PlayingCoverOverlay extends StatelessWidget {
  final double size;
  final bool isPlaying;
  final Color shadowColor;

  const _PlayingCoverOverlay({
    required this.size,
    required this.isPlaying,
    required this.shadowColor,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: shadowColor.withValues(alpha: 0.5),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Center(
        child: Icon(
          isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
          color: Colors.white,
          size: size * 0.4,
        ),
      ),
    );
  }
}
