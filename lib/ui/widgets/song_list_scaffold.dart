import 'package:flutter/material.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'song_list.dart';

class SongListScaffold extends StatelessWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final Color? backgroundColor;
  final VoidCallback? onLoadMore;
  final bool hasMore;
  final bool isLoadingMore;
  final Future<void> Function(Song song)? onSongDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;

  const SongListScaffold({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.backgroundColor,
    this.onLoadMore,
    this.hasMore = false,
    this.isLoadingMore = false,
    this.onSongDoubleTapPlay,
    this.enableDefaultDoubleTapPlay = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Scaffold(
      backgroundColor: backgroundColor ?? theme.scaffoldBackgroundColor,
      body: SongList(
        songs: songs,
        parentPlaylist: parentPlaylist,
        isLoading: isLoading,
        headers: headers,
        onLoadMore: onLoadMore,
        hasMore: hasMore,
        isLoadingMore: isLoadingMore,
        onSongDoubleTapPlay: onSongDoubleTapPlay,
        enableDefaultDoubleTapPlay: enableDefaultDoubleTapPlay,
      ),
    );
  }
}
