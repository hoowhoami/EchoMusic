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
  final bool hasCommentsTab;
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
  final ValueChanged<SongListPrimaryTab>? onPrimaryTabChanged;
  final SongListPrimaryTab initialPrimaryTab;

  const SongListScaffold({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.commentSlivers,
    this.hasCommentsTab = true,
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
    this.onPrimaryTabChanged,
    this.initialPrimaryTab = SongListPrimaryTab.songs,
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
        hasCommentsTab: hasCommentsTab,
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
        onPrimaryTabChanged: onPrimaryTabChanged,
        initialPrimaryTab: initialPrimaryTab,
      ),
    );
  }
}
