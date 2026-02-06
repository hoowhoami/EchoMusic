import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import '../../providers/audio_provider.dart';
import '../../providers/selection_provider.dart';
import 'song_card.dart';

class SongList extends StatefulWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final EdgeInsetsGeometry padding;
  final dynamic sourceId;

  const SongList({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.padding = const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    this.sourceId,
  });

  @override
  State<SongList> createState() => _SongListState();
}

class _SongListState extends State<SongList> {
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  List<Song> get _filteredSongs {
    if (_searchQuery.isEmpty) return widget.songs;
    return widget.songs.where((song) {
      final query = _searchQuery.toLowerCase();
      return song.name.toLowerCase().contains(query) ||
          song.singerName.toLowerCase().contains(query) ||
          song.albumName.toLowerCase().contains(query);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selectionProvider = context.watch<SelectionProvider>();
    final filteredSongs = _filteredSongs;

    if (widget.isLoading) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(80.0),
          child: CupertinoActivityIndicator(),
        ),
      );
    }

    return CustomScrollView(
      physics: const BouncingScrollPhysics(),
      slivers: [
        if (widget.headers != null) ...widget.headers!,
        
        // Sticky Toolbar (Search & Actions)
        SliverPersistentHeader(
          pinned: true,
          delegate: _StickyToolbarDelegate(
            child: Container(
              color: theme.scaffoldBackgroundColor,
              padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
              child: Row(
                children: [
                  // 1. Batch Action on the Left
                  if (widget.songs.isNotEmpty && !selectionProvider.isSelectionMode)
                    _buildBatchActionButton(context, selectionProvider),
                  
                  const Spacer(), // Push others to the right
                  
                  // 2. Controlled Width Search Box
                  Container(
                    width: 240, // Fixed width to keep it neat
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
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12),
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
                  
                  // 3. Locate Button on the Right
                  _buildLocatePlayingButton(context),
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
        else
          SliverPadding(
            padding: widget.padding,
            sliver: SliverList(
              delegate: SliverChildBuilderDelegate(
                (context, index) {
                  final song = filteredSongs[index];
                  return SongCard(
                    song: song,
                    playlist: filteredSongs,
                    parentPlaylist: widget.parentPlaylist,
                    showMore: true,
                    isSelectionMode: selectionProvider.isSelectionMode,
                    isSelected: selectionProvider.isSelected(song.hash),
                    onSelectionChanged: (selected) {
                      selectionProvider.toggleSelection(song.hash);
                    },
                  );
                },
                childCount: filteredSongs.length,
              ),
            ),
          ),
        
        SliverToBoxAdapter(
          child: SizedBox(
            height: selectionProvider.isSelectionMode ? 80 : 20,
          ),
        ),
      ],
    );
  }

  Widget _buildBatchActionButton(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () {
        selectionProvider.setSongList(widget.songs, playlistId: widget.sourceId);
        selectionProvider.enterSelectionMode();
      },
      borderRadius: BorderRadius.circular(10),
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: theme.colorScheme.onSurface.withAlpha(15),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              CupertinoIcons.checkmark_circle,
              size: 16,
              color: theme.colorScheme.onSurface.withAlpha(200),
            ),
            const SizedBox(width: 6),
            Text(
              '批量操作',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: theme.colorScheme.onSurface.withAlpha(200),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildLocatePlayingButton(BuildContext context) {
    final theme = Theme.of(context);
    return Tooltip(
      message: '定位当前播放',
      child: InkWell(
        onTap: () {
          final audioProvider = context.read<AudioProvider>();
          final currentSong = audioProvider.currentSong;
          if (currentSong != null) {
            // Location logic
          }
        },
        borderRadius: BorderRadius.circular(10),
        child: Container(
          height: 36,
          width: 36,
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(15),
            borderRadius: BorderRadius.circular(10),
          ),
          child: Icon(
            CupertinoIcons.scope, // Target/Aim icon
            size: 18,
            color: theme.colorScheme.onSurface.withAlpha(200),
          ),
        ),
      ),
    );
  }
}

class _StickyToolbarDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;

  _StickyToolbarDelegate({required this.child});

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return child;
  }

  @override
  double get maxExtent => 56.0; // 36 height + 20 vertical padding

  @override
  double get minExtent => 56.0;

  @override
  bool shouldRebuild(covariant _StickyToolbarDelegate oldDelegate) {
    return true;
  }
}