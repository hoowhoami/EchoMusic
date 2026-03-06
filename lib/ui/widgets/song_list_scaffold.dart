import 'package:flutter/material.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'song_list.dart';
import 'batch_action_bar.dart';

class SongListScaffold extends StatelessWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final dynamic sourceId;
  final Color? backgroundColor;
  final VoidCallback? onLoadMore;
  final bool hasMore;
  final bool isLoadingMore;

  const SongListScaffold({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.sourceId,
    this.backgroundColor,
    this.onLoadMore,
    this.hasMore = false,
    this.isLoadingMore = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Scaffold(
      backgroundColor: backgroundColor ?? theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          SongList(
            songs: songs,
            parentPlaylist: parentPlaylist,
            isLoading: isLoading,
            headers: headers,
            sourceId: sourceId,
            onLoadMore: onLoadMore,
            hasMore: hasMore,
            isLoadingMore: isLoadingMore,
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }
}
