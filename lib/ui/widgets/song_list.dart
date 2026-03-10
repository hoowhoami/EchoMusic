import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/rendering.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import '../../providers/audio_provider.dart';
import 'song_card.dart';
import 'back_to_top.dart';

class SongList extends StatefulWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final EdgeInsetsGeometry padding;
  final dynamic sourceId;
  final VoidCallback? onLoadMore;
  final bool hasMore;
  final bool isLoadingMore;
  final Future<void> Function(Song song)? onSongDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;
  final Future<List<Song>> Function()? onResolveBatchSongs;

  const SongList({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.padding = const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    this.sourceId,
    this.onLoadMore,
    this.hasMore = false,
    this.isLoadingMore = false,
    this.onSongDoubleTapPlay,
    this.enableDefaultDoubleTapPlay = false,
    this.onResolveBatchSongs,
  });

  @override
  State<SongList> createState() => _SongListState();
}

class _SongListState extends State<SongList> {
  static const double _songItemExtent = 64.0;
  static const double _stickyToolbarHeight = 56.0;

  final ScrollController _scrollController = ScrollController();
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';
  List<Song>? _cachedFilteredSongs;
  List<Song>? _lastSourceSongs;
  String? _lastSearchQuery;
  bool _suppressSongCardHover = false;

  bool get _hasPinnedPrimaryHeader {
    final headers = widget.headers;
    if (headers == null) return false;
    return headers.any((header) => header is SliverAppBar && header.pinned);
  }

  double get _locatePinnedHeight =>
      _stickyToolbarHeight + (_hasPinnedPrimaryHeader ? kToolbarHeight : 0.0);

  double _calculateLocateTargetOffset(int index) {
    final hasHeaders = widget.headers != null && widget.headers!.isNotEmpty;
    final headerHeight = hasHeaders ? 200.0 : 0.0;
    final targetOffset =
        (index * _songItemExtent) +
        headerHeight +
        _stickyToolbarHeight -
        _locatePinnedHeight;
    return targetOffset.clamp(0.0, _scrollController.position.maxScrollExtent).toDouble();
  }

  Future<void> _locateCurrentSong(List<Song> filteredSongs) async {
    final audioProvider = context.read<AudioProvider>();
    final currentSong = audioProvider.currentSong;
    if (currentSong == null || !_scrollController.hasClients) return;

    final index = filteredSongs.indexWhere((song) => song.isSameSong(currentSong));
    if (index == -1) return;

    final position = _scrollController.position;
    final visibleExtent = position.viewportDimension - _locatePinnedHeight;
    if (visibleExtent <= 0) return;

    final itemTop = _calculateLocateTargetOffset(index);
    final itemBottom = itemTop + _songItemExtent;
    final visibleTop = position.pixels;
    final visibleBottom = visibleTop + visibleExtent;

    if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

    final targetOffset = itemTop < visibleTop
        ? itemTop
        : (itemBottom - visibleExtent)
            .clamp(0.0, position.maxScrollExtent)
            .toDouble();

    if ((targetOffset - position.pixels).abs() < 1.0) return;

    await _scrollController.animateTo(
      targetOffset,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeOutCubic,
    );
  }

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _scrollController.dispose();
    _searchController.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (!_scrollController.hasClients) return;
    if (widget.isLoadingMore || !widget.hasMore) return;

    final maxScroll = _scrollController.position.maxScrollExtent;
    final currentScroll = _scrollController.position.pixels;
    final threshold = 200.0;

    if (maxScroll - currentScroll <= threshold) {
      widget.onLoadMore?.call();
    }
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    final shouldSuppress = notification is ScrollStartNotification ||
        notification is ScrollUpdateNotification ||
        notification is OverscrollNotification;
    final shouldRestore = notification is ScrollEndNotification ||
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
    if (_lastSourceSongs == widget.songs && _lastSearchQuery == _searchQuery && _cachedFilteredSongs != null) {
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final filteredSongs = _filteredSongs;
    final listPadding = widget.padding.resolve(Directionality.of(context));

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
          child: CustomScrollView(
            controller: _scrollController,
            physics: const BouncingScrollPhysics(),
            slivers: [
              if (widget.headers != null) ...widget.headers!,
            
            // Sticky Toolbar (Search & Actions)
            SliverPersistentHeader(
              pinned: true,
              delegate: _FixedHeightHeaderDelegate(
                height: _stickyToolbarHeight,
                child: Container(
                  color: theme.scaffoldBackgroundColor,
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
                  child: Row(
                    children: [
                      const Spacer(),

                      // Search Box
                      Container(
                        width: 240,
                        height: 36,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: TextField(
                          controller: _searchController,
                          onChanged: (value) => setState(() => _searchQuery = value),
                          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                          textAlignVertical: TextAlignVertical.center,
                          decoration: InputDecoration(
                            isCollapsed: true,
                            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                            hintText: '搜索列表内歌曲',
                            hintStyle: TextStyle(
                              color: theme.colorScheme.onSurface.withAlpha(100),
                              fontSize: 12,
                            ),
                            prefixIcon: Icon(
                              CupertinoIcons.search,
                              size: 14,
                              color: theme.colorScheme.onSurface.withAlpha(120),
                            ),
                            suffixIcon: _searchQuery.isNotEmpty
                                ? GestureDetector(
                                    onTap: () {
                                      _searchController.clear();
                                      setState(() => _searchQuery = '');
                                    },
                                    child: Icon(
                                      CupertinoIcons.clear_fill,
                                      size: 14,
                                      color: theme.colorScheme.onSurface.withAlpha(120),
                                    ),
                                  )
                                : null,
                            border: InputBorder.none,
                          ),
                        ),
                      ),

                      const SizedBox(width: 12),

                      // Locate Button
                      _buildLocatePlayingButton(context, filteredSongs),
                    ],
                  ),
                ),
              ),
            ),

            if (filteredSongs.isEmpty)
              SliverToBoxAdapter(
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(40.0),
                    child: Text(
                      _searchQuery.isEmpty ? '暂无歌曲' : '未找到相关歌曲',
                      style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                    ),
                  ),
                ),
              )
            else ...[
              SliverPadding(
                padding: EdgeInsets.fromLTRB(listPadding.left, 0, listPadding.right, listPadding.bottom),
                sliver: SliverFixedExtentList(
                  itemExtent: _songItemExtent,
                  delegate: SliverChildBuilderDelegate(
                    (context, index) {
                      final song = filteredSongs[index];
                      return SongCard(
                        song: song,
                        playlist: filteredSongs,
                        parentPlaylist: widget.parentPlaylist,
                        showMore: true,
                        suppressHover: _suppressSongCardHover,
                        onDoubleTapPlay: widget.onSongDoubleTapPlay,
                        enableDefaultDoubleTapPlay:
                            widget.enableDefaultDoubleTapPlay,
                      );
                    },
                    childCount: filteredSongs.length,
                  ),
                ),
              ),
            ],
            
            if (widget.isLoadingMore)
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
        BackToTop(controller: _scrollController),
      ],
    );
  }

  Widget _buildLocatePlayingButton(BuildContext context, List<Song> filteredSongs) {
    final theme = Theme.of(context);
    return InkWell(
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
    );
  }
}

class _FixedHeightHeaderDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;
  final double height;

  _FixedHeightHeaderDelegate({required this.child, required this.height});

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return child;
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