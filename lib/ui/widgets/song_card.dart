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
import 'app_menu.dart';
import 'custom_toast.dart';
import 'playlist_picker_dialog.dart';
import 'song_table_layout.dart';

import '../../models/playlist.dart' as model;

enum _SongCardMenuAction {
  play,
  playNext,
  addToPlaylist,
  removeFromPlaylist,
}

class SongCard extends StatefulWidget {
  final Song song;
  final List<Song> playlist;
  final model.Playlist? parentPlaylist;
  final int? rowNumber;
  final bool showCover;
  final double coverSize;
  final bool showMore;
  final bool suppressHover;
  final bool isRowSelected;
  final VoidCallback? onSelect;
  final Future<void> Function(Song song)? onDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;

  const SongCard({
    super.key,
    required this.song,
    required this.playlist,
    this.parentPlaylist,
    this.rowNumber,
    this.showCover = true,
    this.coverSize = 46,
    this.showMore = false,
    this.suppressHover = false,
    this.isRowSelected = false,
    this.onSelect,
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

  Widget _buildFavoriteButton({
    required bool isFavorite,
    required bool isPlayable,
    required ThemeData theme,
  }) {
    return SizedBox(
      width: SongTableLayout.listFavoriteWidth,
      child: _SongCardActionIconButton(
        icon: isFavorite ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
        tooltip: isFavorite ? '取消收藏' : '收藏',
        onPressed: _toggleFavorite,
        size: 20,
        hoverEnabled: !widget.suppressHover,
        color: isFavorite
            ? Colors.redAccent.withAlpha(isPlayable ? 200 : 120)
            : theme.colorScheme.onSurfaceVariant.withAlpha(
                isPlayable ? 170 : 100,
              ),
        hoverColor: isFavorite
            ? Colors.redAccent.withAlpha(isPlayable ? 255 : 170)
            : theme.colorScheme.primary.withAlpha(isPlayable ? 255 : 150),
      ),
    );
  }

  Widget _buildRowActions({required bool visible}) {
    return SizedBox(
      width: SongTableLayout.listRowActionWidth,
      child: visible
          ? Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                _SongCardActionIconButton(
                  icon: CupertinoIcons.chat_bubble_text,
                  tooltip: '歌曲评论',
                  onPressed: () =>
                      context.read<NavigationProvider>().openSongComment(widget.song),
                ),
                const SizedBox(width: 2),
                _SongCardActionIconButton(
                  icon: CupertinoIcons.info_circle,
                  tooltip: '歌曲详情',
                  onPressed: () =>
                      context.read<NavigationProvider>().openSongDetail(widget.song),
                ),
              ],
            )
          : const SizedBox.shrink(),
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

    setState(() => _isMenuOpen = true);
    final hasPlaylistTarget = userProvider.isAuthenticated &&
        userProvider.createdPlaylists.isNotEmpty;
    final canRemoveFromPlaylist = widget.parentPlaylist != null &&
        userProvider.isCreatedPlaylist(widget.parentPlaylist!.id);

    final value = await showAppContextMenu<_SongCardMenuAction>(
      context,
      width: 228,
      estimatedHeight: canRemoveFromPlaylist
          ? 232
          : (hasPlaylistTarget ? 184 : 136),
      tapPosition: tapPosition,
      anchorContext: tapPosition == null ? anchorContext : null,
      alignRightToAnchor: tapPosition == null,
      menuBuilder: (menuContext, close) {
        Widget buildItem({
          required _SongCardMenuAction action,
          required String label,
          required IconData icon,
          bool isDestructive = false,
        }) {
          final theme = Theme.of(menuContext);
          return AppMenuItemButton(
            leading: Icon(
              icon,
              size: 17,
              color: isDestructive
                  ? theme.colorScheme.error
                  : theme.colorScheme.onSurfaceVariant,
            ),
            title: Text(
              label,
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                color: isDestructive
                    ? theme.colorScheme.error
                    : theme.colorScheme.onSurface,
              ),
            ),
            isDestructive: isDestructive,
            showCheckmark: false,
            onPressed: () => close(action),
          );
        }

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            buildItem(
              action: _SongCardMenuAction.play,
              label: '立即播放',
              icon: CupertinoIcons.play_circle,
            ),
            buildItem(
              action: _SongCardMenuAction.playNext,
              label: '添加下一首播放',
              icon: CupertinoIcons.add,
            ),
            if (hasPlaylistTarget)
              buildItem(
                action: _SongCardMenuAction.addToPlaylist,
                label: '添加到歌单',
                icon: CupertinoIcons.add_circled,
              ),
            if (canRemoveFromPlaylist) ...[
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                child: Divider(
                  height: 1,
                  color: Theme.of(menuContext)
                      .colorScheme
                      .outlineVariant
                      .withAlpha(120),
                ),
              ),
              buildItem(
                action: _SongCardMenuAction.removeFromPlaylist,
                label: '从歌单中删除',
                icon: CupertinoIcons.trash,
                isDestructive: true,
              ),
            ],
          ],
        );
      },
    );

    if (mounted) setState(() => _isMenuOpen = false);
    if (value == null || !mounted) return;

    if (value == _SongCardMenuAction.play) {
      _queueAndPlayCurrentSong();
    } else if (value == _SongCardMenuAction.playNext) {
      _addCurrentSongToPlayNext();
    } else if (value == _SongCardMenuAction.addToPlaylist) {
      final playlist = await showPlaylistPickerDialog(
        context,
        playlists: userProvider.createdPlaylists,
      );
      if (playlist == null || !mounted) return;
      final success = await userProvider.addSongToPlaylist(
        playlist['listid'] ?? playlist['specialid'],
        widget.song,
      );
      if (!mounted) return;
      _showActionToast(
        success: success,
        successMessage: '已添加到歌单',
        failureMessage: '添加失败',
      );
    } else if (value == _SongCardMenuAction.removeFromPlaylist) {
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
                  final isSingleRowSelected =
                      widget.isRowSelected && !isSelectionMode;
                  final isHoveringCard =
                      _isCardHovered &&
                      !widget.suppressHover &&
                      !isSelectionMode &&
                      !_isMenuOpen;
                  final showRowActions =
                      widget.showMore &&
                      !isSelectionMode &&
                      (isSingleRowSelected || isHoveringCard);

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
                            : widget.onSelect,
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
                          decoration: isSingleRowSelected ||
                                  (isSelectionMode && isSelected) ||
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
                                if (widget.rowNumber != null)
                                  SizedBox(
                                    width: SongTableLayout.listLeadingWidth,
                                    child: Align(
                                      alignment: Alignment.centerLeft,
                                      child: Text(
                                        widget.rowNumber.toString(),
                                        style: TextStyle(
                                          color: isCurrent
                                              ? primaryColor.withAlpha(isPlayable ? 220 : 170)
                                              : theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 170 : 110),
                                          fontSize: 12,
                                          fontWeight: isCurrent ? FontWeight.w800 : FontWeight.w600,
                                        ),
                                      ),
                                    ),
                                  ),
                                if (widget.showCover) ...[
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
                                ],
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
                                if (widget.showMore && !isSelectionMode) ...[
                                  const SizedBox(width: SongTableLayout.listActionGap),
                                  _buildRowActions(visible: showRowActions),
                                ],
                                const SizedBox(width: SongTableLayout.listFavoriteGap),
                                _buildFavoriteButton(
                                  isFavorite: isFavorite,
                                  isPlayable: isPlayable,
                                  theme: theme,
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
                                  builder: (_) => _SongCardContextMenuButton(
                                    iconColor: theme.colorScheme.onSurfaceVariant.withAlpha(
                                      isPlayable ? 180 : 120,
                                    ),
                                    onOpen: (anchorContext) =>
                                        _showContextMenu(anchorContext: anchorContext),
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

class _SongCardContextMenuButton extends StatefulWidget {
  final Color iconColor;
  final ValueChanged<BuildContext> onOpen;

  const _SongCardContextMenuButton({
    required this.iconColor,
    required this.onOpen,
  });

  @override
  State<_SongCardContextMenuButton> createState() =>
      _SongCardContextMenuButtonState();
}

class _SongCardContextMenuButtonState extends State<_SongCardContextMenuButton> {
  final GlobalKey _anchorKey = GlobalKey();

  void _openMenu() {
    final anchorContext = _anchorKey.currentContext;
    if (anchorContext == null) return;
    widget.onOpen(anchorContext);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(999),
        child: InkWell(
          borderRadius: BorderRadius.circular(999),
          hoverColor: theme.colorScheme.onSurface.withAlpha(20),
          splashColor: theme.colorScheme.primary.withAlpha(32),
          highlightColor: theme.colorScheme.primary.withAlpha(18),
          onTapDown: (_) => _openMenu(),
          onTap: () {},
          child: SizedBox(
            key: _anchorKey,
            width: 38,
            height: 38,
            child: Center(
              child: Icon(
                CupertinoIcons.ellipsis,
                size: 17,
                color: widget.iconColor,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SongCardActionIconButton extends StatefulWidget {
  final IconData icon;
  final VoidCallback? onPressed;
  final double size;
  final String tooltip;
  final Color? color;
  final Color? hoverColor;
  final bool hoverEnabled;

  const _SongCardActionIconButton({
    required this.icon,
    required this.tooltip,
    this.onPressed,
    this.size = 20,
    this.color,
    this.hoverColor,
    this.hoverEnabled = true,
  });

  @override
  State<_SongCardActionIconButton> createState() =>
      _SongCardActionIconButtonState();
}

class _SongCardActionIconButtonState extends State<_SongCardActionIconButton> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final disabled = widget.onPressed == null;
    final hoverEnabled = widget.hoverEnabled && !disabled;
    final color = disabled
        ? theme.disabledColor
        : (_isHovered && hoverEnabled
              ? (widget.hoverColor ?? theme.colorScheme.primary)
              : (widget.color ?? theme.colorScheme.onSurfaceVariant.withAlpha(180)));

    return MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) {
        if (hoverEnabled) setState(() => _isHovered = true);
      },
      onExit: (_) {
        if (_isHovered) setState(() => _isHovered = false);
      },
      child: Tooltip(
        message: widget.tooltip,
        waitDuration: const Duration(milliseconds: 500),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onPressed,
          child: AnimatedScale(
            scale: _isHovered && hoverEnabled ? 1.15 : 1.0,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutBack,
            child: Container(
              padding: const EdgeInsets.all(8),
              color: Colors.transparent,
              child: Icon(widget.icon, size: widget.size, color: color),
            ),
          ),
        ),
      ),
    );
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
