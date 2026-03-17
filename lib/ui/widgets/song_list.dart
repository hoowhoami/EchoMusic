import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import '../../providers/audio_provider.dart';
import 'song_card.dart';
import 'back_to_top.dart';
import 'song_table_layout.dart';
import 'detail_page_sliver_header.dart';
import 'package:echomusic/theme/app_theme.dart';

enum _SongSortField { order, title, album, duration }

enum SongListPrimaryTab { songs, comments }

class _SongListEntry {
  final Song song;
  final int originalIndex;

  const _SongListEntry({required this.song, required this.originalIndex});
}

class SongList extends StatefulWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final List<Widget>? commentSlivers;
  final bool hasCommentsTab;
  final EdgeInsetsGeometry padding;
  final dynamic sourceId;
  final VoidCallback? onLoadMore;
  final VoidCallback? onCommentsLoadMore;
  final bool hasMore;
  final bool hasMoreComments;
  final bool isLoadingMore;
  final bool isLoadingMoreComments;
  final Future<void> Function(Song song)? onSongDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;
  final bool showStickyToolbar;
  final bool showTableHeader;
  final bool showSearchField;
  final bool showLocateButton;
  final double rowHorizontalPadding;
  final double? backToTopRight;
  final double? backToTopBottom;
  final Future<List<Song>> Function()? onResolveBatchSongs;
  final String commentsTabTitle;
  final String? commentsTabBadgeLabel;
  final ValueChanged<SongListPrimaryTab>? onPrimaryTabChanged;
  final SongListPrimaryTab initialPrimaryTab;

  const SongList({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.commentSlivers,
    this.hasCommentsTab = true,
    this.padding = const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    this.sourceId,
    this.onLoadMore,
    this.onCommentsLoadMore,
    this.hasMore = false,
    this.hasMoreComments = false,
    this.isLoadingMore = false,
    this.isLoadingMoreComments = false,
    this.onSongDoubleTapPlay,
    this.enableDefaultDoubleTapPlay = false,
    this.onResolveBatchSongs,
    this.commentsTabTitle = '评论',
    this.commentsTabBadgeLabel,
    this.onPrimaryTabChanged,
    this.initialPrimaryTab = SongListPrimaryTab.songs,
    this.showStickyToolbar = true,
    this.showTableHeader = true,
    this.showSearchField = true,
    this.showLocateButton = true,
    this.rowHorizontalPadding = SongTableLayout.listRowHorizontalPadding,
    this.backToTopRight,
    this.backToTopBottom,
  });

  @override
  State<SongList> createState() => _SongListState();
}

class _SongListState extends State<SongList> {
  static const double _songItemExtent = 60.0;
  static const double _compactAlbumWidth = 140.0;
  static const double _compactDurationWidth = 44.0;
  static const double _stickyToolbarHeight = 60.0;
  static const double _tableHeaderHeight = 44.0;
  static const double _searchBoxMaxWidth = 240.0;
  static const double _toolbarHeightWithoutExtras = 44.0;

  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();
  final GlobalKey _listAnchorKey = GlobalKey();
  String _searchQuery = '';
  String? _selectedSongKey;
  List<Song>? _cachedFilteredSongs;
  List<Song>? _lastSourceSongs;
  String? _lastSearchQuery;
  bool _suppressSongCardHover = false;
  _SongSortField _sortField = _SongSortField.order;
  bool _sortAscending = true;
  late SongListPrimaryTab _activePrimaryTab;
  double? _listLeadingScrollExtent;

  bool get _hasCommentTab => widget.hasCommentsTab;

  String _songSelectionKey(Song song, int index) {
    if (song.hash.isNotEmpty) return song.hash;
    return '${song.title}|${song.displayAlbumName}|$index';
  }

  bool get _hasPinnedPrimaryHeader {
    final headers = widget.headers;
    if (headers == null) return false;
    return headers.any((header) {
      if (header is SliverAppBar) return header.pinned;
      if (header is SliverPersistentHeader) return header.pinned;
      return header is DetailPageSliverHeader;
    });
  }

  double get _pinnedPrimaryHeaderHeight {
    final headers = widget.headers;
    if (headers == null) return 0.0;

    double height = 0.0;
    for (final header in headers) {
      if (header is SliverAppBar && header.pinned) {
        height += header.collapsedHeight ?? header.toolbarHeight;
      } else if (header is SliverPersistentHeader && header.pinned) {
        height += header.delegate.minExtent;
      } else if (header is DetailPageSliverHeader) {
        height += kToolbarHeight;
      }
    }
    return height;
  }

  double get _estimatedHeaderScrollExtent {
    final headers = widget.headers;
    if (headers == null) return 0.0;

    return headers.fold<double>(0.0, (sum, header) {
      if (header is SliverAppBar) {
        final expandedHeight =
            header.expandedHeight ??
            header.collapsedHeight ??
            header.toolbarHeight;
        final collapsedHeight = header.pinned
            ? (header.collapsedHeight ?? header.toolbarHeight)
            : 0.0;
        final scrollExtent = expandedHeight - collapsedHeight;
        return sum + math.max(scrollExtent, 0.0);
      }

      if (header is SliverToBoxAdapter) {
        return sum + 48.0;
      }

      return sum + 44.0;
    });
  }

  double _locatePinnedHeight(bool hasTableHeader) {
    final topInset = widget.showStickyToolbar
        ? MediaQuery.of(context).padding.top
        : 0.0;
    final stickyHeight = widget.showStickyToolbar
        ? (widget.showSearchField || widget.showLocateButton
              ? _stickyToolbarHeight
              : _toolbarHeightWithoutExtras)
        : 0.0;
    return stickyHeight +
        (hasTableHeader ? _tableHeaderHeight : 0.0) +
        (_hasPinnedPrimaryHeader ? _pinnedPrimaryHeaderHeight : 0.0) +
        topInset;
  }

  double _resolvePinnedHeight(bool hasTableHeader) {
    return _locatePinnedHeight(hasTableHeader);
  }

  double _calculateLocateTargetOffset(int index, double leadingExtent) {
    final headerOffset = leadingExtent;
    return headerOffset + (index * _songItemExtent);
  }

  Future<void> _locateCurrentSong(List<Song> filteredSongs) async {
    final audioProvider = context.read<AudioProvider>();
    final currentSong = audioProvider.currentSong;
    if (currentSong == null || !_scrollController.hasClients) return;

    final index = filteredSongs.indexWhere(
      (song) => song.isSameSong(currentSong),
    );
    if (index == -1) return;

    final position = _scrollController.position;
    final hasTableHeader = widget.showTableHeader && filteredSongs.isNotEmpty;
    final pinnedHeight = _resolvePinnedHeight(hasTableHeader);
    final leadingExtent =
        _listLeadingScrollExtent ?? _estimatedHeaderScrollExtent;
    final visibleExtent = position.viewportDimension - pinnedHeight;
    if (visibleExtent <= _songItemExtent) return;

    final alignedOffset = _calculateLocateTargetOffset(index, leadingExtent);
    final itemTop = alignedOffset;
    final itemBottom = alignedOffset + _songItemExtent;
    final visibleTop = position.pixels + pinnedHeight;
    final visibleBottom = position.pixels + position.viewportDimension;

    if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

    final targetOffset = itemTop < visibleTop
        ? (alignedOffset - pinnedHeight)
              .clamp(0.0, position.maxScrollExtent)
              .toDouble()
        : (itemBottom - position.viewportDimension)
              .clamp(0.0, position.maxScrollExtent)
              .toDouble();

    if ((targetOffset - position.pixels).abs() < 1.0) return;

    await _scrollController.animateTo(
      targetOffset,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeOutCubic,
    );
  }

  void _toggleSort(_SongSortField field) {
    setState(() {
      if (_sortField != field) {
        _sortField = field;
        _sortAscending = true;
        return;
      }

      if (_sortAscending) {
        _sortAscending = !_sortAscending;
        return;
      }

      _sortField = _SongSortField.order;
      _sortAscending = true;
    });
  }

  bool _isSortActive(_SongSortField field) {
    if (_sortField != field) return false;
    return field != _SongSortField.order || !_sortAscending;
  }

  int _compareEntries(_SongListEntry a, _SongListEntry b) {
    int compare;
    switch (_sortField) {
      case _SongSortField.order:
        compare = a.originalIndex.compareTo(b.originalIndex);
        break;
      case _SongSortField.title:
        compare = a.song.title.toLowerCase().compareTo(
          b.song.title.toLowerCase(),
        );
        break;
      case _SongSortField.album:
        compare = a.song.displayAlbumName.toLowerCase().compareTo(
          b.song.displayAlbumName.toLowerCase(),
        );
        break;
      case _SongSortField.duration:
        compare = a.song.duration.compareTo(b.song.duration);
        break;
    }

    if (compare == 0) {
      compare = a.originalIndex.compareTo(b.originalIndex);
    }

    return _sortAscending ? compare : -compare;
  }

  @override
  void initState() {
    super.initState();
    _activePrimaryTab = widget.hasCommentsTab
        ? widget.initialPrimaryTab
        : SongListPrimaryTab.songs;
    _scrollController.addListener(_onScroll);
    if (_activePrimaryTab == SongListPrimaryTab.comments) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        widget.onPrimaryTabChanged?.call(_activePrimaryTab);
      });
    }
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(covariant SongList oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!_hasCommentTab && _activePrimaryTab == SongListPrimaryTab.comments) {
      _activePrimaryTab = SongListPrimaryTab.songs;
    }

    if (_activePrimaryTab == SongListPrimaryTab.comments &&
        widget.hasCommentsTab &&
        widget.commentSlivers == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        widget.onPrimaryTabChanged?.call(_activePrimaryTab);
      });
    }
  }

  void _setPrimaryTab(SongListPrimaryTab tab) {
    if (_activePrimaryTab == tab) return;
    setState(() => _activePrimaryTab = tab);
    widget.onPrimaryTabChanged?.call(tab);
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;

    if (_activePrimaryTab == SongListPrimaryTab.comments) {
      if (widget.isLoadingMoreComments || !widget.hasMoreComments) return;
    } else {
      if (widget.isLoadingMore || !widget.hasMore) return;
    }

    final maxScroll = _scrollController.position.maxScrollExtent;
    final currentScroll = _scrollController.position.pixels;
    final threshold = 200.0;

    if (maxScroll - currentScroll <= threshold) {
      if (_activePrimaryTab == SongListPrimaryTab.comments) {
        widget.onCommentsLoadMore?.call();
      } else {
        widget.onLoadMore?.call();
      }
    }
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    final shouldSuppress =
        notification is ScrollStartNotification ||
        notification is ScrollUpdateNotification ||
        notification is OverscrollNotification;
    final shouldRestore =
        notification is ScrollEndNotification ||
        (notification is UserScrollNotification &&
            notification.direction == ScrollDirection.idle);

    if (shouldSuppress && !_suppressSongCardHover) {
      setState(() => _suppressSongCardHover = true);
    } else if (shouldRestore && _suppressSongCardHover) {
      setState(() => _suppressSongCardHover = false);
    }

    return false;
  }

  List<Song> get _filteredSongs {
    if (_lastSourceSongs == widget.songs &&
        _lastSearchQuery == _searchQuery &&
        _cachedFilteredSongs != null) {
      return _cachedFilteredSongs!;
    }

    _lastSourceSongs = widget.songs;
    _lastSearchQuery = _searchQuery;

    if (_searchQuery.isEmpty) {
      _cachedFilteredSongs = widget.songs;
    } else {
      final query = _searchQuery.toLowerCase();
      _cachedFilteredSongs = widget.songs.where((song) {
        return song.name.toLowerCase().contains(query) ||
            song.singerName.toLowerCase().contains(query) ||
            song.albumName.toLowerCase().contains(query);
      }).toList();
    }
    return _cachedFilteredSongs!;
  }

  List<_SongListEntry> get _sortedEntries {
    final entries = [
      for (var index = 0; index < _filteredSongs.length; index++)
        _SongListEntry(song: _filteredSongs[index], originalIndex: index),
    ];
    entries.sort(_compareEntries);
    return entries;
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final theme = Theme.of(context);
        final sortedEntries = _sortedEntries;
        final filteredSongs = [for (final entry in sortedEntries) entry.song];
        final listPadding = widget.padding.resolve(Directionality.of(context));
        final isCommentsTabActive =
            _hasCommentTab && _activePrimaryTab == SongListPrimaryTab.comments;
        final baseAvailableWidth =
            (constraints.maxWidth - listPadding.horizontal).clamp(
              0.0,
              double.infinity,
            );
        final baseColumnConfig = _resolveColumnConfig(baseAvailableWidth);
        final rowHorizontalPadding =
            (baseColumnConfig.rowHorizontalPadding < widget.rowHorizontalPadding
                    ? baseColumnConfig.rowHorizontalPadding
                    : widget.rowHorizontalPadding)
                .clamp(0.0, 24.0);
        final availableWidth = (baseAvailableWidth - (rowHorizontalPadding * 2))
            .clamp(0.0, double.infinity);
        final finalColumnConfig = _resolveColumnConfig(availableWidth);

        if (widget.isLoading) {
          return const Center(
            child: Padding(
              padding: EdgeInsets.all(80.0),
              child: CupertinoActivityIndicator(),
            ),
          );
        }

        return Stack(
          children: [
            NotificationListener<ScrollNotification>(
              onNotification: _handleScrollNotification,
              child: Scrollbar(
                controller: _scrollController,
                child: CustomScrollView(
                  controller: _scrollController,
                  physics: const BouncingScrollPhysics(),
                  slivers: [
                    if (widget.headers != null) ...widget.headers!,

                    if (widget.showStickyToolbar)
                      SliverPersistentHeader(
                        pinned: true,
                        delegate: _FixedHeightHeaderDelegate(
                          height:
                              (widget.showSearchField ||
                                  widget.showLocateButton)
                              ? _stickyToolbarHeight
                              : _toolbarHeightWithoutExtras,
                          child: _buildStickyToolbar(
                            context,
                            isCommentsTabActive: isCommentsTabActive,
                            filteredSongs: filteredSongs,
                            listPadding: listPadding,
                          ),
                        ),
                      ),

                    if (widget.showTableHeader &&
                        !isCommentsTabActive &&
                        filteredSongs.isNotEmpty)
                      SliverPersistentHeader(
                        pinned: true,
                        delegate: _FixedHeightHeaderDelegate(
                          height: _tableHeaderHeight,
                          child: _buildTableHeader(
                            context,
                            listPadding: listPadding,
                            columnConfig: finalColumnConfig,
                            rowHorizontalPadding: rowHorizontalPadding,
                          ),
                        ),
                      ),

                    if (isCommentsTabActive)
                      ...?widget.commentSlivers
                    else if (filteredSongs.isEmpty)
                      SliverToBoxAdapter(
                        child: Center(
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(24, 32, 24, 40),
                            child: Text(
                              _searchQuery.isEmpty ? '暂无歌曲' : '未找到相关歌曲',
                              style: TextStyle(
                                color: theme.colorScheme.onSurfaceVariant,
                              ),
                            ),
                          ),
                        ),
                      )
                    else ...[
                      SliverToBoxAdapter(
                        key: _listAnchorKey,
                        child: const SizedBox.shrink(),
                      ),
                      SliverLayoutBuilder(
                        builder: (context, constraints) {
                          _listLeadingScrollExtent =
                              constraints.precedingScrollExtent;
                          return SliverPadding(
                            padding: EdgeInsets.fromLTRB(
                              listPadding.left,
                              0,
                              listPadding.right,
                              listPadding.bottom,
                            ),
                            sliver: SliverFixedExtentList(
                              itemExtent: _songItemExtent,
                              delegate: SliverChildBuilderDelegate((
                                context,
                                index,
                              ) {
                                final song = filteredSongs[index];
                                final songSelectionKey = _songSelectionKey(
                                  song,
                                  index,
                                );
                                return SongCard(
                                  song: song,
                                  playlist: filteredSongs,
                                  parentPlaylist: widget.parentPlaylist,
                                  rowNumber: index + 1,
                                  showMore: true,
                                  showAlbum: finalColumnConfig.showAlbum,
                                  showDuration: finalColumnConfig.showDuration,
                                  albumWidth: finalColumnConfig.albumWidth,
                                  durationWidth:
                                      finalColumnConfig.durationWidth,
                                  rowHorizontalPadding: rowHorizontalPadding,
                                  isRowSelected:
                                      _selectedSongKey == songSelectionKey,
                                  onSelect: () {
                                    if (_selectedSongKey == songSelectionKey) {
                                      return;
                                    }
                                    setState(
                                      () => _selectedSongKey = songSelectionKey,
                                    );
                                  },
                                  suppressHover: _suppressSongCardHover,
                                  onDoubleTapPlay: widget.onSongDoubleTapPlay,
                                  enableDefaultDoubleTapPlay:
                                      widget.enableDefaultDoubleTapPlay,
                                );
                              }, childCount: filteredSongs.length),
                            ),
                          );
                        },
                      ),
                    ],

                    if (isCommentsTabActive
                        ? widget.isLoadingMoreComments
                        : widget.isLoadingMore)
                      const SliverToBoxAdapter(
                        child: Padding(
                          padding: EdgeInsets.all(16.0),
                          child: Center(child: CupertinoActivityIndicator()),
                        ),
                      ),

                    const SliverToBoxAdapter(child: SizedBox(height: 20)),
                  ],
                ),
              ),
            ),
            BackToTop(
              controller: _scrollController,
              right: widget.backToTopRight ?? 24,
              bottom: widget.backToTopBottom ?? 24,
            ),
          ],
        );
      },
    );
  }

  Widget _buildStickyToolbar(
    BuildContext context, {
    required bool isCommentsTabActive,
    required List<Song> filteredSongs,
    required EdgeInsets listPadding,
  }) {
    final theme = Theme.of(context);
    final hasExtras = widget.showSearchField || widget.showLocateButton;

    return Container(
      color: theme.scaffoldBackgroundColor,
      height: hasExtras ? _stickyToolbarHeight : _toolbarHeightWithoutExtras,
      child: Padding(
        padding: EdgeInsets.fromLTRB(
          listPadding.left,
          hasExtras ? 10 : 6,
          listPadding.right,
          hasExtras ? 10 : 6,
        ),
        child: Row(
          children: [
            _buildPrimaryTabs(context, filteredSongs.length),
            if (!isCommentsTabActive &&
                (widget.showSearchField || widget.showLocateButton)) ...[
              const Spacer(),
              if (widget.showSearchField)
                Flexible(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(
                        maxWidth: _searchBoxMaxWidth,
                      ),
                      child: _buildSearchField(context),
                    ),
                  ),
                ),
              if (widget.showSearchField && widget.showLocateButton)
                const SizedBox(width: 12),
              if (widget.showLocateButton)
                _buildLocatePlayingButton(context, filteredSongs),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildPrimaryTabs(BuildContext context, int filteredCount) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildSongsTab(
          context,
          filteredCount,
          isSelected: _activePrimaryTab == SongListPrimaryTab.songs,
          onTap: () {
            _setPrimaryTab(SongListPrimaryTab.songs);
          },
        ),
        if (_hasCommentTab) ...[
          const SizedBox(width: 18),
          _buildCommentsTab(
            context,
            isSelected: _activePrimaryTab == SongListPrimaryTab.comments,
            onTap: () {
              _setPrimaryTab(SongListPrimaryTab.comments);
            },
          ),
        ],
      ],
    );
  }

  Widget _buildSongsTab(
    BuildContext context,
    int filteredCount, {
    required bool isSelected,
    required VoidCallback onTap,
  }) {
    final totalCount = widget.songs.length;
    final badgeLabel = _searchQuery.isNotEmpty && filteredCount != totalCount
        ? '$filteredCount / $totalCount'
        : '$totalCount';
    return _buildPrimaryTab(
      context,
      title: '歌曲',
      badgeLabel: badgeLabel,
      isSelected: isSelected,
      onTap: onTap,
      keySuffix: 'songs',
    );
  }

  Widget _buildCommentsTab(
    BuildContext context, {
    required bool isSelected,
    required VoidCallback onTap,
  }) {
    return _buildPrimaryTab(
      context,
      title: widget.commentsTabTitle,
      badgeLabel: widget.commentsTabBadgeLabel,
      isSelected: isSelected,
      onTap: onTap,
      keySuffix: 'comments',
    );
  }

  Widget _buildPrimaryTab(
    BuildContext context, {
    required String title,
    required bool isSelected,
    required VoidCallback onTap,
    required String keySuffix,
    String? badgeLabel,
  }) {
    final theme = Theme.of(context);
    final hasBadge = badgeLabel != null && badgeLabel.isNotEmpty;
    final titleStyle = TextStyle(
      color: isSelected
          ? theme.colorScheme.onSurface
          : theme.colorScheme.onSurface.withAlpha(160),
      fontSize: 14,
      fontWeight: AppTheme.fontWeightBold,
    );
    final badgeTextStyle = const TextStyle(
      color: Colors.white,
      fontSize: 10,
      fontWeight: AppTheme.fontWeightBold,
      height: 1.1,
    );
    final textDirection = Directionality.of(context);
    final titlePainter = TextPainter(
      text: TextSpan(text: title, style: titleStyle),
      textDirection: textDirection,
      maxLines: 1,
    )..layout();
    final titleWidth = titlePainter.width;
    final badgePainter = TextPainter(
      text: TextSpan(text: badgeLabel ?? '', style: badgeTextStyle),
      textDirection: textDirection,
      maxLines: 1,
    )..layout();
    final badgeWidth = hasBadge ? badgePainter.width + 14 : 0.0;
    final badgeLeft = hasBadge ? math.max(titleWidth - 2, 0.0) : 0.0;
    final tabWidth = hasBadge
        ? math.max(titleWidth, badgeLeft + badgeWidth)
        : titleWidth;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          key: ValueKey('song-list-primary-tab-$keySuffix'),
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          splashFactory: NoSplash.splashFactory,
          overlayColor: WidgetStateProperty.all(Colors.transparent),
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
          focusColor: Colors.transparent,
          hoverColor: Colors.transparent,
          child: SizedBox(
            width: tabWidth,
            height: 36,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                Positioned(
                  left: 0,
                  bottom: 7,
                  child: Text(title, style: titleStyle),
                ),
                if (hasBadge)
                  Positioned(
                    left: badgeLeft,
                    top: 0,
                    child: Container(
                      key: ValueKey('song-list-tab-count-badge-$keySuffix'),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 7,
                        vertical: 2,
                      ),
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary,
                        borderRadius: BorderRadius.circular(999),
                        border: Border.all(
                          color: theme.colorScheme.surface,
                          width: 1.5,
                        ),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withAlpha(40),
                            blurRadius: 4,
                            offset: const Offset(0, 1),
                          ),
                        ],
                      ),
                      child: Text(badgeLabel, style: badgeTextStyle),
                    ),
                  ),
                if (isSelected)
                  Positioned(
                    left: 0,
                    bottom: 0,
                    child: Container(
                      width: titleWidth,
                      height: 2,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.primary.withAlpha(150),
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildSearchField(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      height: 36,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(15),
        borderRadius: BorderRadius.circular(10),
      ),
      child: TextField(
        controller: _searchController,
        onChanged: (value) => setState(() => _searchQuery = value),
        cursorColor: theme.colorScheme.primary,
        style: TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 13,
          fontWeight: AppTheme.fontWeightSemiBold,
          height: 1.2,
        ),
        textAlignVertical: TextAlignVertical.center,
        decoration: InputDecoration(
          isDense: true,
          contentPadding: const EdgeInsets.fromLTRB(0, 9, 12, 9),
          hintText: '搜索列表内歌曲',
          hintStyle: TextStyle(
            color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
            fontSize: 12,
            fontWeight: AppTheme.fontWeightMedium,
            height: 1.2,
          ),
          prefixIcon: Padding(
            padding: const EdgeInsets.only(left: 12, right: 8),
            child: Icon(
              CupertinoIcons.search,
              size: 14,
              color: theme.colorScheme.onSurface.withAlpha(120),
            ),
          ),
          prefixIconConstraints: const BoxConstraints(
            minWidth: 34,
            minHeight: 36,
          ),
          suffixIcon: _searchQuery.isNotEmpty
              ? Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: IconButton(
                    onPressed: () {
                      _searchController.clear();
                      setState(() => _searchQuery = '');
                    },
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints.tightFor(
                      width: 18,
                      height: 18,
                    ),
                    splashRadius: 12,
                    icon: Icon(
                      CupertinoIcons.clear_fill,
                      size: 14,
                      color: theme.colorScheme.onSurface.withAlpha(120),
                    ),
                  ),
                )
              : null,
          suffixIconConstraints: const BoxConstraints(
            minWidth: 30,
            minHeight: 36,
          ),
          border: InputBorder.none,
        ),
      ),
    );
  }

  Widget _buildTableHeader(
    BuildContext context, {
    required EdgeInsets listPadding,
    required _SongColumnConfig columnConfig,
    required double rowHorizontalPadding,
  }) {
    final theme = Theme.of(context);
    final actionSectionWidth =
        SongTableLayout.listActionGap +
        SongTableLayout.listRowActionWidth +
        SongTableLayout.listFavoriteGap +
        SongTableLayout.listFavoriteWidth;
    final albumWidth = columnConfig.albumWidth;
    final durationWidth = columnConfig.durationWidth;
    return Container(
      decoration: BoxDecoration(
        color: theme.scaffoldBackgroundColor,
        border: Border(
          bottom: BorderSide(
            color: theme.dividerColor.withAlpha(35),
            width: 0.5,
          ),
        ),
      ),
      child: Padding(
        padding: EdgeInsets.only(
          left: listPadding.left,
          right: listPadding.right,
        ),
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: rowHorizontalPadding),
          child: Row(
            children: [
              SizedBox(
                width: SongTableLayout.listLeadingWidth,
                child: _buildSortHeaderCell(
                  context,
                  label: '#',
                  field: _SongSortField.order,
                  alignment: Alignment.center,
                ),
              ),
              const SizedBox(width: SongTableLayout.listCoverSectionWidth),
              Expanded(
                child: _buildSortHeaderCell(
                  context,
                  label: '歌曲',
                  field: _SongSortField.title,
                  alignment: Alignment.centerLeft,
                ),
              ),
              SizedBox(width: actionSectionWidth),
              if (columnConfig.showAlbum || columnConfig.showDuration) ...[
                const SizedBox(width: SongTableLayout.listAlbumGap),
                if (columnConfig.showAlbum)
                  SizedBox(
                    width: albumWidth,
                    child: _buildSortHeaderCell(
                      context,
                      label: '专辑',
                      field: _SongSortField.album,
                      alignment: Alignment.centerLeft,
                    ),
                  ),
                if (columnConfig.showDuration) ...[
                  const SizedBox(width: SongTableLayout.listDurationGap),
                  SizedBox(
                    width: durationWidth,
                    child: _buildSortHeaderCell(
                      context,
                      label: '时长',
                      field: _SongSortField.duration,
                      alignment: Alignment.centerRight,
                    ),
                  ),
                ],
              ],
              const SizedBox(width: SongTableLayout.listTrailingActionWidth),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSortHeaderCell(
    BuildContext context, {
    required String label,
    required _SongSortField field,
    Alignment alignment = Alignment.centerLeft,
    EdgeInsetsGeometry contentPadding = EdgeInsets.zero,
  }) {
    final theme = Theme.of(context);
    final isActive = _isSortActive(field);
    final foregroundColor = isActive
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurfaceVariant;
    final inactiveArrowColor = theme.colorScheme.onSurfaceVariant.withAlpha(
      150,
    );
    final icon = isActive
        ? (_sortAscending
              ? Icons.keyboard_arrow_up_rounded
              : Icons.keyboard_arrow_down_rounded)
        : Icons.unfold_more_rounded;
    final iconSize = isActive ? 16.0 : 18.0;
    final iconColor = isActive ? foregroundColor : inactiveArrowColor;

    return SizedBox(
      height: _tableHeaderHeight,
      width: double.infinity,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: () => _toggleSort(field),
          borderRadius: BorderRadius.circular(8),
          hoverColor: Colors.transparent,
          child: Padding(
            padding: contentPadding,
            child: Align(
              alignment: alignment,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      color: foregroundColor,
                      fontSize: 12,
                      fontWeight: AppTheme.fontWeightSemiBold,
                    ),
                  ),
                  const SizedBox(width: 5),
                  Icon(icon, size: iconSize, color: iconColor),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildLocatePlayingButton(
    BuildContext context,
    List<Song> filteredSongs,
  ) {
    final theme = Theme.of(context);
    return Tooltip(
      message: '定位当前播放',
      child: InkWell(
        onTap: () => _locateCurrentSong(filteredSongs),
        borderRadius: BorderRadius.circular(10),
        child: Container(
          height: 36,
          width: 36,
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(15),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(
            CupertinoIcons.scope,
            size: 18,
            color: theme.colorScheme.onSurface.withAlpha(200),
          ),
        ),
      ),
    );
  }

  _SongColumnConfig _resolveColumnConfig(double availableWidth) {
    final baseWidth =
        SongTableLayout.listLeadingWidth +
        SongTableLayout.listCoverSectionWidth +
        SongTableLayout.listActionGap +
        SongTableLayout.listRowActionWidth +
        SongTableLayout.listFavoriteGap +
        SongTableLayout.listFavoriteWidth +
        SongTableLayout.listTrailingActionWidth;
    final fullWidth =
        baseWidth +
        SongTableLayout.listAlbumGap +
        SongTableLayout.listAlbumWidth +
        SongTableLayout.listDurationGap +
        SongTableLayout.listDurationWidth;
    final compactWidth =
        baseWidth +
        SongTableLayout.listAlbumGap +
        _compactAlbumWidth +
        SongTableLayout.listDurationGap +
        _compactDurationWidth;
    final durationOnlyWidth =
        baseWidth +
        SongTableLayout.listAlbumGap +
        SongTableLayout.listDurationGap +
        _compactDurationWidth;

    final availableWithDefaultPadding =
        availableWidth - (SongTableLayout.listRowHorizontalPadding * 2);
    if (availableWithDefaultPadding >= fullWidth) {
      return _SongColumnConfig(
        showAlbum: true,
        showDuration: true,
        albumWidth: SongTableLayout.listAlbumWidth,
        durationWidth: SongTableLayout.listDurationWidth,
        rowHorizontalPadding: SongTableLayout.listRowHorizontalPadding,
      );
    }
    if (availableWithDefaultPadding >= compactWidth) {
      return _SongColumnConfig(
        showAlbum: true,
        showDuration: true,
        albumWidth: _compactAlbumWidth,
        durationWidth: _compactDurationWidth,
        rowHorizontalPadding: SongTableLayout.listRowHorizontalPadding,
      );
    }
    if (availableWithDefaultPadding >= durationOnlyWidth) {
      return _SongColumnConfig(
        showAlbum: false,
        showDuration: true,
        albumWidth: _compactAlbumWidth,
        durationWidth: _compactDurationWidth,
        rowHorizontalPadding: SongTableLayout.listRowHorizontalPadding,
      );
    }
    const condensedPadding = 6.0;
    final availableWithCondensedPadding =
        availableWidth - (condensedPadding * 2);

    if (availableWithCondensedPadding >= durationOnlyWidth) {
      return const _SongColumnConfig(
        showAlbum: false,
        showDuration: true,
        albumWidth: _compactAlbumWidth,
        durationWidth: _compactDurationWidth,
        rowHorizontalPadding: condensedPadding,
      );
    }

    return const _SongColumnConfig(
      showAlbum: false,
      showDuration: false,
      albumWidth: _compactAlbumWidth,
      durationWidth: _compactDurationWidth,
      rowHorizontalPadding: condensedPadding,
    );
  }
}

class _SongColumnConfig {
  final bool showAlbum;
  final bool showDuration;
  final double albumWidth;
  final double durationWidth;
  final double rowHorizontalPadding;

  const _SongColumnConfig({
    required this.showAlbum,
    required this.showDuration,
    required this.albumWidth,
    required this.durationWidth,
    required this.rowHorizontalPadding,
  });
}

class _FixedHeightHeaderDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;
  final double height;

  _FixedHeightHeaderDelegate({required this.child, required this.height});

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return SizedBox.expand(child: child);
  }

  @override
  double get maxExtent => height;

  @override
  double get minExtent => height;

  @override
  bool shouldRebuild(covariant _FixedHeightHeaderDelegate oldDelegate) {
    return oldDelegate.height != height || oldDelegate.child != child;
  }
}
