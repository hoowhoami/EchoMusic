import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/navigation_provider.dart';
import 'cover_image.dart';
import 'custom_toast.dart';
import 'song_table_layout.dart';

import '../../models/playlist.dart' as model;

class SongCard extends StatefulWidget {
  final Song song;
  final List<Song> playlist;
  final model.Playlist? parentPlaylist;
  final bool showCover;
  final double coverSize;
  final bool showMore;
  final bool suppressHover;
  final Future<void> Function(Song song)? onDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;

  const SongCard({
    super.key,
    required this.song,
    required this.playlist,
    this.parentPlaylist,
    this.showCover = true,
    this.coverSize = 46,
    this.showMore = false,
    this.suppressHover = false,
    this.onDoubleTapPlay,
    this.enableDefaultDoubleTapPlay = false,
  });

  @override
  State<SongCard> createState() => _SongCardState();
}

class _SongCardState extends State<SongCard> {
  bool _isMenuOpen = false;
  bool _isCardHovered = false;
  bool _isCoverHovered = false;

  List<SingerInfo> get _displaySingers =>
      widget.song.singers.where((singer) => Song.normalizeDisplayText(singer.name).isNotEmpty).toList(growable: false);

  int get _albumDetailId => int.tryParse(widget.song.albumId ?? '0') ?? 0;

  bool get _hasAlbumDetail => _albumDetailId > 0 && widget.song.albumName.trim().isNotEmpty;

  @override
  void didUpdateWidget(covariant SongCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.suppressHover && !oldWidget.suppressHover) {
      _isCardHovered = false;
      _isCoverHovered = false;
    }
  }

  void _showUnavailableToast(BuildContext context) {
    CustomToast.error(context, '该歌曲暂无可用音源');
  }

  void _queueAndPlayCurrentSong() {
    if (!widget.song.isPlayable) {
      _showUnavailableToast(context);
      return;
    }
    unawaited(context.read<AudioProvider>().queueAndPlaySong(widget.song));
  }

  void _addCurrentSongToPlayNext() {
    if (!widget.song.isPlayable) {
      _showUnavailableToast(context);
      return;
    }
    context.read<AudioProvider>().addSongToPlayNext(widget.song);
  }

  void _handleCoverPlayTap({
    required bool isCurrent,
    required bool isPlaying,
    required bool isLoading,
  }) {
    if (isLoading) return;
    if (isCurrent) {
      context.read<AudioProvider>().togglePlay();
      return;
    }
    _queueAndPlayCurrentSong();
  }

  void _handleSongDoubleTap({
    required bool isCurrent,
    required bool isPlaying,
    required bool isLoading,
  }) {
    if (widget.onDoubleTapPlay != null) {
      unawaited(widget.onDoubleTapPlay!(widget.song));
      return;
    }
    if (!widget.enableDefaultDoubleTapPlay) return;
    _handleCoverPlayTap(
      isCurrent: isCurrent,
      isPlaying: isPlaying,
      isLoading: isLoading,
    );
  }

  void _showActionToast({required bool success, required String successMessage, required String failureMessage}) {
    if (success) {
      CustomToast.success(context, successMessage);
    } else {
      CustomToast.error(context, failureMessage);
    }
  }

  Future<void> _toggleFavorite() async {
    final userProvider = Provider.of<UserProvider?>(context, listen: false);
    await context.read<PersistenceProvider>().toggleFavorite(
      widget.song,
      userProvider: userProvider,
    );
  }

  void _openArtistDetail(SingerInfo singer) {
    if (singer.id <= 0) {
      CustomToast.error(context, '暂无歌手信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute('artist_detail', id: singer.id)) {
      return;
    }
    context.read<NavigationProvider>().openArtist(singer.id, Song.normalizeDisplayText(singer.name));
  }

  void _openAlbumDetail() {
    if (!_hasAlbumDetail) {
      CustomToast.error(context, '暂无专辑信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute('album_detail', id: _albumDetailId)) {
      return;
    }
    context.read<NavigationProvider>().openAlbum(_albumDetailId, widget.song.displayAlbumName);
  }

  Widget _buildLinkText({
    required String text,
    required TextStyle style,
    required VoidCallback? onTap,
  }) {
    final child = Text(
      Song.normalizeDisplayText(text),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: style,
    );

    if (onTap == null) return child;

    return MouseRegion(
      cursor: widget.suppressHover ? SystemMouseCursors.basic : SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: child,
      ),
    );
  }

  Widget _buildSingerLinks({
    required TextStyle style,
    required bool enabled,
    required bool isPlayable,
    required NavigationProvider navigationProvider,
  }) {
    final singers = _displaySingers;
    if (singers.isEmpty) {
      return Text(
        widget.song.displaySingerName,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: style,
      );
    }

    return Wrap(
      spacing: 0,
      runSpacing: 0,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        for (int index = 0; index < singers.length; index++) ...[
          _buildLinkText(
            text: singers[index].name,
            style: style,
            onTap: enabled && singers[index].id > 0 && !navigationProvider.isCurrentRoute('artist_detail', id: singers[index].id)
                ? () => _openArtistDetail(singers[index])
                : null,
          ),
          if (index < singers.length - 1)
            Text(
              ' / ',
              style: style.copyWith(color: style.color?.withAlpha(isPlayable ? 180 : 120)),
            ),
        ],
      ],
    );
  }

  Future<void> _showContextMenu({Offset? tapPosition, BuildContext? anchorContext}) async {
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
        value: 'playNext',
        child: Row(
          children: [
            Icon(CupertinoIcons.add, size: 18),
            SizedBox(width: 12),
            Text('添加下一首播放', style: TextStyle(fontSize: 14)),
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
      final RenderBox box =
          (anchorContext ?? context).findRenderObject() as RenderBox;
      final Offset offset = box.localToGlobal(Offset.zero, ancestor: overlay);
      position = RelativeRect.fromRect(
        Rect.fromLTWH(
          offset.dx,
          offset.dy,
          box.size.width,
          box.size.height,
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
      _queueAndPlayCurrentSong();
    } else if (value == 'playNext') {
      _addCurrentSongToPlayNext();
    } else if (value == 'songDetails') {
      context.read<NavigationProvider>().openSongDetail(widget.song);
    } else if (value == 'songComments') {
      context.read<NavigationProvider>().openSongComment(widget.song);
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
    final navigationProvider = context.watch<NavigationProvider>();
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

          return Selector<AudioProvider, ({bool isCurrent, bool isPlaying, bool isLoading})>(
            selector: (_, provider) => (
              isCurrent: provider.currentSong?.isSameSong(widget.song) ?? false,
              isPlaying: provider.isPlaying,
              isLoading: provider.isLoading,
            ),
            builder: (context, playbackState, child) {
              final isCurrent = playbackState.isCurrent;
              final isPlaying = isCurrent && playbackState.isPlaying;
              final isLoading = isCurrent && playbackState.isLoading;
              final isPlayable = widget.song.isPlayable;
              final contentOpacity = isPlayable ? 1.0 : 0.45;

              return Selector<PersistenceProvider, bool>(
                selector: (_, provider) => provider.isFavorite(widget.song),
                builder: (context, isFavorite, child) {
                  final isHoveringCard =
                      _isCardHovered &&
                      !widget.suppressHover &&
                      !isSelectionMode &&
                      !_isMenuOpen;

                  return GestureDetector(
                    onSecondaryTapDown: (details) =>
                        _showContextMenu(tapPosition: details.globalPosition),
                    child: MouseRegion(
                      onEnter: (_) {
                        if (widget.suppressHover) return;
                        setState(() => _isCardHovered = true);
                      },
                      onExit: (_) => setState(() => _isCardHovered = false),
                      child: InkWell(
                        mouseCursor: SystemMouseCursors.basic,
                        overlayColor: WidgetStateProperty.all(Colors.transparent),
                        hoverColor: Colors.transparent,
                        focusColor: Colors.transparent,
                        highlightColor: Colors.transparent,
                        splashColor: Colors.transparent,
                        splashFactory: NoSplash.splashFactory,
                        onTap: isSelectionMode
                            ? () => context.read<SelectionProvider>().toggleSelection(widget.song.hash)
                            : null,
                        onDoubleTap: !isSelectionMode &&
                                (widget.onDoubleTapPlay != null ||
                                    widget.enableDefaultDoubleTapPlay)
                            ? () => _handleSongDoubleTap(
                                isCurrent: isCurrent,
                                isPlaying: isPlaying,
                                isLoading: isLoading,
                              )
                            : null,
                        borderRadius: BorderRadius.circular(16),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 120),
                          curve: Curves.easeOut,
                          decoration: (isSelectionMode && isSelected) ||
                                  _isMenuOpen ||
                                  isHoveringCard
                              ? BoxDecoration(
                                  color: primaryColor.withAlpha(
                                    _isMenuOpen ? 30 : (isHoveringCard ? 12 : 20),
                                  ),
                                  borderRadius: BorderRadius.circular(16),
                                  border: Border.all(
                                    color: primaryColor.withAlpha(
                                      _isMenuOpen ? 80 : (isHoveringCard ? 40 : 0),
                                    ),
                                    width: _isMenuOpen ? 1.5 : 1,
                                  ),
                                )
                              : null,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(
                              horizontal: SongTableLayout.listRowHorizontalPadding,
                              vertical: 5,
                            ),
                            child: Row(
                              children: [
                              if (isSelectionMode)
                                Padding(
                                  padding: const EdgeInsets.only(right: 10),
                                  child: Checkbox(
                                    value: isSelected,
                                    onChanged: (value) => context.read<SelectionProvider>().toggleSelection(widget.song.hash),
                                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(4)),
                                    side: BorderSide(
                                      color: theme.colorScheme.outline,
                                      width: 1.5,
                                    ),
                                    visualDensity: const VisualDensity(horizontal: -4, vertical: -4),
                                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                  ),
                                ),
                              if (widget.showCover)
                                Opacity(
                                  opacity: contentOpacity,
                                  child: _buildCover(
                                    context,
                                    isCurrent,
                                    isPlaying,
                                    isLoading,
                                    primaryColor,
                                  ),
                                ),
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
                                            widget.song.title,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              color: isCurrent
                                                  ? primaryColor.withAlpha(isPlayable ? 255 : 170)
                                                  : theme.colorScheme.onSurface.withAlpha(isPlayable ? 255 : 140),
                                              fontWeight: isCurrent ? FontWeight.w800 : FontWeight.w700,
                                              fontSize: 14,
                                              height: 1,
                                              letterSpacing: -0.3,
                                            ),
                                          ),
                                        ),
                                        Tooltip(
                                          message: isFavorite ? '取消收藏' : '收藏',
                                          child: MouseRegion(
                                            cursor: widget.suppressHover
                                                ? SystemMouseCursors.basic
                                                : SystemMouseCursors.click,
                                            child: GestureDetector(
                                              behavior: HitTestBehavior.opaque,
                                              onTap: _toggleFavorite,
                                              child: Padding(
                                                padding: const EdgeInsets.only(left: 4),
                                                child: Icon(
                                                  isFavorite
                                                      ? CupertinoIcons.heart_fill
                                                      : CupertinoIcons.heart,
                                                  size: 15,
                                                  color: isFavorite
                                                      ? Colors.redAccent.withAlpha(
                                                          isPlayable ? 200 : 120,
                                                        )
                                                      : theme.colorScheme.onSurfaceVariant
                                                          .withAlpha(isPlayable ? 170 : 100),
                                                ),
                                              ),
                                            ),
                                          ),
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
                                    _buildSingerLinks(
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 255 : 140),
                                        fontSize: 12,
                                        height: 1.1,
                                        fontWeight: FontWeight.w600,
                                      ),
                                      enabled: !isSelectionMode,
                                      isPlayable: isPlayable,
                                      navigationProvider: navigationProvider,
                                    ),
                                  ],
                                ),
                              ),
                              if (widget.showMore) ...[
                                const SizedBox(width: SongTableLayout.listAlbumGap),
                                SizedBox(
                                  width: SongTableLayout.listAlbumWidth,
                                  child: _buildLinkText(
                                    text: widget.song.displayAlbumName,
                                    onTap: !isSelectionMode && _hasAlbumDetail && !isCurrentAlbumDetail ? _openAlbumDetail : null,
                                    style: TextStyle(
                                      color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 255 : 140),
                                      fontSize: 12,
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: SongTableLayout.listDurationGap),
                                SizedBox(
                                  width: SongTableLayout.listDurationWidth,
                                  child: Align(
                                    alignment: Alignment.centerRight,
                                    child: Text(
                                      _formatDuration(widget.song.duration),
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 150 : 100),
                                        fontSize: 12,
                                        fontFamily: 'monospace',
                                        fontWeight: FontWeight.w500,
                                      ),
                                    ),
                                  ),
                                ),
                              ],
                              const SizedBox(width: 8),
                              Builder(
                                builder: (buttonContext) => IconButton(
                                  icon: const Icon(CupertinoIcons.ellipsis, size: 17),
                                  onPressed: () =>
                                      _showContextMenu(anchorContext: buttonContext),
                                  color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 180 : 120),
                                  splashRadius: 22,
                                  padding: const EdgeInsets.all(2),
                                  constraints: const BoxConstraints(minWidth: 38, minHeight: 38),
                                  visualDensity: const VisualDensity(horizontal: -1.5, vertical: -1.5),
                                ),
                              ),
                              ],
                            ),
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

  Widget _buildCover(
    BuildContext context,
    bool isCurrent,
    bool isPlaying,
    bool isLoading,
    Color primaryColor,
  ) {
    final showOverlay = (!widget.suppressHover && _isCoverHovered) || isCurrent;
    final tooltip = isCurrent && isPlaying ? '暂停当前歌曲' : '播放当前歌曲';

    return MouseRegion(
      onEnter: (_) {
        if (widget.suppressHover) return;
        setState(() => _isCoverHovered = true);
      },
      onExit: (_) => setState(() => _isCoverHovered = false),
      child: Stack(
        children: [
          CoverImage(
            url: widget.song.cover,
            width: widget.coverSize,
            height: widget.coverSize,
            borderRadius: 12,
            size: 100,
            showShadow: false,
          ),
          if (showOverlay)
            Positioned.fill(
              child: Tooltip(
                message: tooltip,
                child: MouseRegion(
                  cursor: widget.suppressHover || isLoading || !widget.song.isPlayable
                      ? SystemMouseCursors.basic
                      : SystemMouseCursors.click,
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => _handleCoverPlayTap(
                      isCurrent: isCurrent,
                      isPlaying: isPlaying,
                      isLoading: isLoading,
                    ),
                    onDoubleTap: widget.onDoubleTapPlay != null ||
                            widget.enableDefaultDoubleTapPlay
                        ? () => _handleSongDoubleTap(
                            isCurrent: isCurrent,
                            isPlaying: isPlaying,
                            isLoading: isLoading,
                          )
                        : null,
                    child: _PlayingCoverOverlay(
                      size: widget.coverSize,
                      isPlaying: isPlaying,
                      isLoading: isLoading,
                      shadowColor: Theme.of(context).colorScheme.shadow,
                      iconColor: primaryColor,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
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
  final bool isLoading;
  final Color shadowColor;
  final Color iconColor;

  const _PlayingCoverOverlay({
    required this.size,
    required this.isPlaying,
    required this.isLoading,
    required this.shadowColor,
    required this.iconColor,
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
        child: isLoading
            ? SizedBox(
                width: size * 0.32,
                height: size * 0.32,
                child: const CupertinoActivityIndicator(color: Colors.white),
              )
            : Icon(
                isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
                color: iconColor.withValues(alpha: 0.98),
                size: size * 0.4,
              ),
      ),
    );
  }
}
