import 'package:flutter/material.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'song_list.dart';
import 'song_table_layout.dart';

class SongListScaffold extends StatelessWidget {
  final List<Song> songs;
  final Playlist? parentPlaylist;
  final bool isLoading;
  final List<Widget>? headers;
  final List<Widget>? commentSlivers;
  final bool hasCommentsTab;
  final Color? backgroundColor;
  final EdgeInsetsGeometry padding;
  final double rowHorizontalPadding;
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
  final bool showStickyToolbar;
  final bool showTableHeader;
  final bool showSearchField;
  final bool showLocateButton;

  const SongListScaffold({
    super.key,
    required this.songs,
    this.parentPlaylist,
    this.isLoading = false,
    this.headers,
    this.commentSlivers,
    this.hasCommentsTab = true,
    this.backgroundColor,
    this.padding = const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
    this.rowHorizontalPadding = SongTableLayout.listRowHorizontalPadding,
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
    this.showStickyToolbar = true,
    this.showTableHeader = true,
    this.showSearchField = true,
    this.showLocateButton = true,
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
        padding: padding,
        rowHorizontalPadding: rowHorizontalPadding,
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
        showStickyToolbar: showStickyToolbar,
        showTableHeader: showTableHeader,
        showSearchField: showSearchField,
        showLocateButton: showLocateButton,
      ),
    );
  }
}
