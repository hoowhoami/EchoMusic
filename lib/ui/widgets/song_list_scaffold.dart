import 'package:flutter/material.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'song_list.dart';

class SongListScaffold extends StatelessWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final List<Widget>? commentSlivers;
  final Color? backgroundColor;
  final VoidCallback? onLoadMore;
  final VoidCallback? onCommentsLoadMore;
  final bool hasMore;
  final bool hasMoreComments;
  final bool isLoadingMore;
  final bool isLoadingMoreComments;
  final Future<void> Function(Song song)? onSongDoubleTapPlay;
  final bool enableDefaultDoubleTapPlay;
  final String commentsTabTitle;
  final String? commentsTabBadgeLabel;

  const SongListScaffold({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.commentSlivers,
    this.backgroundColor,
    this.onLoadMore,
    this.onCommentsLoadMore,
    this.hasMore = false,
    this.hasMoreComments = false,
    this.isLoadingMore = false,
    this.isLoadingMoreComments = false,
    this.onSongDoubleTapPlay,
    this.enableDefaultDoubleTapPlay = false,
    this.commentsTabTitle = '评论',
    this.commentsTabBadgeLabel,
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
        commentSlivers: commentSlivers,
        onLoadMore: onLoadMore,
        onCommentsLoadMore: onCommentsLoadMore,
        hasMore: hasMore,
        hasMoreComments: hasMoreComments,
        isLoadingMore: isLoadingMore,
        isLoadingMoreComments: isLoadingMoreComments,
        onSongDoubleTapPlay: onSongDoubleTapPlay,
        enableDefaultDoubleTapPlay: enableDefaultDoubleTapPlay,
        commentsTabTitle: commentsTabTitle,
        commentsTabBadgeLabel: commentsTabBadgeLabel,
      ),
    );
  }
}
