import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/album.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import '../../providers/navigation_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/custom_toast.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';
import '../../models/playlist.dart' as model;
import '../widgets/comment_floor_sheet.dart';
import '../widgets/resource_comment_slivers.dart';

@visibleForTesting
String resolveAlbumCommentId(Album? album, int fallbackAlbumId) {
  return '${album?.id ?? fallbackAlbumId}';
}

class AlbumDetailView extends StatefulWidget {
  final int albumId;
  final String albumName;
  const AlbumDetailView({
    super.key,
    required this.albumId,
    required this.albumName,
  });

  @override
  State<AlbumDetailView> createState() => _AlbumDetailViewState();
}

class _AlbumDetailViewState extends State<AlbumDetailView>
    with RefreshableState {
  static const int _pageSize = 50;

  @override
  String get refreshKey => 'album_detail:${widget.albumId}';

  Album? _album;
  List<Song>? _songs;
  bool _isLoading = true;
  int _currentPage = 1;
  bool _hasMore = true;
  bool _isLoadingMore = false;
  bool _isResolvingAllSongs = false;
  bool _hasScheduledWarmUp = false;
  List<Song>? _allSongsCache;
  Future<List<Song>>? _resolveAllSongsFuture;
  AudioProvider? _playbackAppendProvider;
  int? _playbackAppendSessionId;
  List<_AlbumAuthor> _authors = const <_AlbumAuthor>[];

  void _openArtistDetail(
    BuildContext context,
    int artistId,
    String artistName,
  ) {
    if (artistId <= 0) {
      CustomToast.error(context, '暂无歌手信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute(
      'artist_detail',
      id: artistId,
    )) {
      return;
    }
    context.read<NavigationProvider>().openArtist(
      artistId,
      artistName,
    );
  }

  bool _isCommentsLoading = false;
  bool _isFetchingMoreComments = false;
  bool _hasMoreComments = true;
  int _currentCommentPage = 1;
  static const int _commentPageSize = 30;
  final List<dynamic> _allComments = [];
  List<dynamic> _hotComments = [];
  int _totalCommentCount = 0;
  bool _hasLoadedComments = false;

  int get _totalSongCount => _album?.songCount ?? 0;

  String get _albumCommentId {
    return resolveAlbumCommentId(_album, widget.albumId);
  }

  bool _computeHasMore({required int loadedCount, required int lastPageCount}) {
    final totalSongCount = _totalSongCount;
    if (totalSongCount > 0) return loadedCount < totalSongCount;
    return lastPageCount >= _pageSize;
  }

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  @override
  void onRefresh() {
    _loadData();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _currentPage = 1;
      _hasMore = true;
      _isLoadingMore = false;
      _isResolvingAllSongs = false;
      _hasScheduledWarmUp = false;
      _allSongsCache = null;
      _resolveAllSongsFuture = null;
      _playbackAppendProvider = null;
      _playbackAppendSessionId = null;
      _isCommentsLoading = true;
      _isFetchingMoreComments = false;
      _hasMoreComments = true;
      _currentCommentPage = 1;
      _allComments.clear();
      _hotComments = [];
      _totalCommentCount = 0;
      _hasLoadedComments = false;
      _authors = const <_AlbumAuthor>[];
    });

    final results = await Future.wait([
      MusicApi.getAlbumDetail(widget.albumId),
      _fetchSongsPage(1),
    ]);

    if (mounted) {
      setState(() {
        final albumJson = results[0] as Map<String, dynamic>?;
        if (albumJson != null) {
          _album = Album.fromDetailJson(albumJson);
          _authors = _parseAuthors(albumJson);
        }
        final songs = results[1] as List<Song>?;
        _songs = songs;
        _isLoading = false;
        final loadedCount = songs?.length ?? 0;
        _hasMore = _computeHasMore(
          loadedCount: loadedCount,
          lastPageCount: loadedCount,
        );
        if (!_hasMore) {
          _allSongsCache = List.unmodifiable(songs ?? const <Song>[]);
        }
      });

      _scheduleBackgroundResolve();
    }
  }

  Widget _buildAuthorLine(BuildContext context, ThemeData theme) {
    if (_album == null) return const SizedBox.shrink();
    final authors = _authors;
    if (authors.isEmpty) return const SizedBox.shrink();

    final canOpenAny = authors.any((author) {
      return author.id > 0 &&
          !context.read<NavigationProvider>().isCurrentRoute(
                'artist_detail',
                id: author.id,
              );
    });
    final baseStyle = TextStyle(
      color: theme.colorScheme.onSurface,
      fontSize: 14,
      fontWeight: FontWeight.w700,
    );
    final spans = <InlineSpan>[];
    for (var index = 0; index < authors.length; index++) {
      final author = authors[index];
      final canOpen = author.id > 0 &&
          !context.read<NavigationProvider>().isCurrentRoute(
                'artist_detail',
                id: author.id,
              );
      final style = baseStyle.copyWith(
        color: canOpen ? theme.colorScheme.primary : baseStyle.color,
      );
      spans.add(
        TextSpan(
          text: author.name,
          style: style,
          recognizer: canOpen
              ? (TapGestureRecognizer()
                ..onTap =
                    () => _openArtistDetail(context, author.id, author.name))
              : null,
        ),
      );
      if (index < authors.length - 1) {
        spans.add(
          TextSpan(
            text: ' / ',
            style: style.copyWith(color: style.color?.withAlpha(180)),
          ),
        );
      }
    }

    return MouseRegion(
      cursor: canOpenAny ? SystemMouseCursors.click : MouseCursor.defer,
      child: Text.rich(
        TextSpan(children: spans),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        softWrap: false,
      ),
    );
  }

  void _onPrimaryTabChanged(SongListPrimaryTab tab) {
    if (tab != SongListPrimaryTab.comments || _hasLoadedComments) return;
    _hasLoadedComments = true;
    unawaited(_fetchComments(isRefresh: true));
  }

  void _scheduleBackgroundResolve() {
    if (_hasScheduledWarmUp || !_hasMore || !mounted) return;
    _hasScheduledWarmUp = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_hasMore) return;
      unawaited(_ensureAllSongsLoaded());
    });
  }

  Future<List<Song>> _fetchSongsPage(int page) {
    return MusicApi.getAlbumSongs(
      widget.albumId,
      page: page,
      pagesize: _pageSize,
    );
  }

  Future<void> _fetchComments({bool isRefresh = false}) async {
    if ((_isCommentsLoading || _isFetchingMoreComments) && !isRefresh) return;
    _hasLoadedComments = true;

    if (mounted) {
      setState(() {
        if (isRefresh) {
          _isCommentsLoading = true;
          _currentCommentPage = 1;
          _hasMoreComments = true;
          _allComments.clear();
          _hotComments = [];
          _totalCommentCount = 0;
        } else {
          _isFetchingMoreComments = true;
        }
      });
    }

    try {
      final data = await MusicApi.getAlbumComments(
        _albumCommentId,
        page: _currentCommentPage,
        pagesize: _commentPageSize,
        showClassify: isRefresh,
        showHotwordList: isRefresh,
      );
      final payload = data['data'] is Map<String, dynamic>
          ? data['data'] as Map<String, dynamic>
          : data;
      final newComments = payload['list'] is List
          ? List<dynamic>.from(payload['list'] as List)
          : const <dynamic>[];
      final totalCount = _asInt(
        payload['count'] ?? payload['total'] ?? data['count'] ?? data['total'],
      );
      final hotComments = payload['hot_list'] is List
          ? List<dynamic>.from(payload['hot_list'] as List)
          : payload['weight_list'] is List
              ? List<dynamic>.from(payload['weight_list'] as List)
              : const <dynamic>[];

      if (!mounted) return;
      setState(() {
        if (isRefresh) {
          _hotComments = hotComments;
          _totalCommentCount = totalCount;
        }
        _allComments.addAll(newComments);
        _hasMoreComments = totalCount > 0
            ? _allComments.length < totalCount
            : newComments.length >= _commentPageSize;
        if (_hasMoreComments) {
          _currentCommentPage++;
        }
        _isCommentsLoading = false;
        _isFetchingMoreComments = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isCommentsLoading = false;
        _isFetchingMoreComments = false;
        _hasMoreComments = false;
      });
    }
  }

  void _loadMoreComments() {
    if (_isCommentsLoading || _isFetchingMoreComments || !_hasMoreComments) {
      return;
    }
    unawaited(_fetchComments());
  }

  Future<void> _openAlbumFloorComments(Map<String, dynamic> rawComment) async {
    final comment = Map<String, dynamic>.from(rawComment);
    final specialId = _firstNonEmptyString([comment['special_child_id']]);
    final tid = _firstNonEmptyString([comment['id']]);
    final code = _firstNonEmptyString([comment['code']]);

    if (specialId == null || tid == null || code == null) {
      CustomToast.error(context, '专辑楼层评论暂不可用');
      return;
    }

    await showCommentFloorSheet(
      context,
      comment: comment,
      unavailableMessage: '专辑楼层评论暂不可用',
      onFetch: ({required page, required pagesize}) {
        return MusicApi.getFloorComments(
          specialId,
          tid,
          code: code,
          resourceType: 'album',
          page: page,
          pagesize: pagesize,
        );
      },
    );
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || !_hasMore || !mounted) return;

    setState(() => _isLoadingMore = true);
    try {
      await _ensureAllSongsLoaded();
    } finally {
      if (mounted) {
        setState(() => _isLoadingMore = false);
      }
    }
  }

  Future<List<Song>> _loadAllSongsForBatch() => _ensureAllSongsLoaded();

  Future<List<Song>> _ensureAllSongsLoaded() async {
    if (_allSongsCache != null) {
      return _allSongsCache!;
    }

    final existingFuture = _resolveAllSongsFuture;
    if (existingFuture != null) {
      return existingFuture;
    }

    if (_isLoading) return List<Song>.from(_songs ?? const <Song>[]);

    if (!_hasMore) {
      final songs = List<Song>.unmodifiable(_songs ?? const <Song>[]);
      _allSongsCache = songs;
      return songs;
    }

    if (mounted) {
      setState(() => _isResolvingAllSongs = true);
    } else {
      _isResolvingAllSongs = true;
    }

    final future = _resolveAllSongsInternal();
    _resolveAllSongsFuture = future;
    try {
      return await future;
    } finally {
      if (mounted) {
        setState(() => _isResolvingAllSongs = false);
      } else {
        _isResolvingAllSongs = false;
      }
    }
  }

  Future<List<Song>> _resolveAllSongsInternal() async {
    final songs = [...?_songs];
    var nextPage = _currentPage + 1;
    var lastLoadedPage = _currentPage;
    var hasMore = _hasMore;

    try {
      while (hasMore) {
        final moreSongs = await _fetchSongsPage(nextPage);
        if (moreSongs.isEmpty) {
          hasMore = false;
          break;
        }
        songs.addAll(moreSongs);
        lastLoadedPage = nextPage;
        hasMore = _computeHasMore(
          loadedCount: songs.length,
          lastPageCount: moreSongs.length,
        );

        final playbackProvider = _playbackAppendProvider;
        final playbackSessionId = _playbackAppendSessionId;
        if (playbackProvider != null && playbackSessionId != null) {
          if (playbackProvider.playlistSessionId == playbackSessionId) {
            if (!playbackProvider.appendSongsToActivePlaylist(
              moreSongs,
              sessionId: playbackSessionId,
            )) {
              _playbackAppendProvider = null;
              _playbackAppendSessionId = null;
            }
          } else {
            _playbackAppendProvider = null;
            _playbackAppendSessionId = null;
          }
        }

        if (mounted) {
          setState(() {
            _songs = List<Song>.from(songs);
            _currentPage = lastLoadedPage;
            _hasMore = hasMore;
          });
        }
        nextPage++;
      }

      final resolvedSongs = List<Song>.unmodifiable(songs);
      _allSongsCache = resolvedSongs;
      _resolveAllSongsFuture = Future.value(resolvedSongs);

      if (mounted) {
        setState(() {
          _songs = List<Song>.from(songs);
          _currentPage = lastLoadedPage;
          _hasMore = hasMore;
        });
      }

      return resolvedSongs;
    } catch (_) {
      _resolveAllSongsFuture = null;
      rethrow;
    }
  }

  void _attachPlaybackPrefetch(AudioProvider audioProvider, int sessionId) {
    _playbackAppendProvider = audioProvider;
    _playbackAppendSessionId = sessionId;
  }

  void _playAlbumSongs() {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前专辑暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithAlbumSongs(songs[firstPlayableIndex]));
  }

  Future<void> _replacePlaybackWithAlbumSongs(Song song) async {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前专辑暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
    final sessionId = audioProvider.playlistSessionId;
    _attachPlaybackPrefetch(audioProvider, sessionId);
    unawaited(_ensureAllSongsLoaded());
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final theme = Theme.of(context);
    final replacePlaylistEnabled = context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );
    final isFavorited = userProvider.isPlaylistFavorited(widget.albumId);
    final songs = _songs ?? const <Song>[];
    final batchPreparing = _isResolvingAllSongs && _hasMore;

    final secondaryActions = <DetailPageSecondaryAction>[
      if (userProvider.isAuthenticated)
        DetailPageSecondaryAction(
          icon: isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
          label: '收藏',
          emphasized: isFavorited,
          onTap: () async {
            if (_album == null) return;

            bool success;
            if (isFavorited) {
              success = await userProvider.unfavoriteAlbum(widget.albumId);
              if (context.mounted && success) {
                CustomToast.success(context, '已取消收藏');
              }
            } else {
              success = await userProvider.favoriteAlbum(
                widget.albumId,
                widget.albumName,
                singerId: _album!.singerId,
              );
              if (context.mounted && success) {
                CustomToast.success(context, '已收藏专辑');
              }
            }
          },
        ),
    ];

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore || batchPreparing,
      commentSlivers: _hasLoadedComments
          ? buildResourceCommentSlivers(
              context: context,
              isLoading: _isCommentsLoading,
              hotComments: _hotComments,
              comments: _allComments,
              totalCount: _totalCommentCount,
              onTapReplies: _openAlbumFloorComments,
            )
          : null,
      onCommentsLoadMore: _loadMoreComments,
      hasMoreComments: _hasMoreComments,
      isLoadingMoreComments: _isFetchingMoreComments,
      commentsTabBadgeLabel: _totalCommentCount > 0
          ? '$_totalCommentCount'
          : null,
      onPrimaryTabChanged: _onPrimaryTabChanged,
      initialPrimaryTab: SongListPrimaryTab.songs,
      hasCommentsTab: true,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? _replacePlaybackWithAlbumSongs
          : null,
      parentPlaylist: _album != null
          ? model.Playlist(
              id: _album!.id,
              listCreateListid: _album!.id,
              name: _album!.name,
              pic: _album!.pic,
              intro: _album!.intro,
              playCount: _album!.playCount,
              source: 2,
            )
          : null,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'ALBUM',
          title: widget.albumName,
          expandedHeight: 200,
          expandedCover: CoverImage(
            url: _album?.pic ?? '',
            width: 136,
            height: 136,
            borderRadius: 18,
          ),
          collapsedCover: CoverImage(
            url: _album?.pic ?? '',
            width: 32,
            height: 32,
            borderRadius: 6,
            showShadow: false,
          ),
          detailChildren: [
            _buildAuthorLine(context, theme),
            if (_album != null)
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (_album!.publishTime.isNotEmpty)
                    _buildInfoSmall(
                      context,
                      CupertinoIcons.time,
                      _album!.publishTime,
                    ),
                  _buildInfoSmall(
                    context,
                    Icons.favorite_rounded,
                    _formatNumber(_album!.heat),
                  ),
                  if (_album!.language.isNotEmpty)
                    _buildTag(context, _album!.language),
                  if (_album!.type.isNotEmpty) _buildTag(context, _album!.type),
                ],
              ),
          ],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: _playAlbumSongs,
            songs: songs,
            sourceId: widget.albumId,
            onResolveSongs: _loadAllSongsForBatch,
            isBatchPreparing: batchPreparing,
            secondaryActions: secondaryActions,
          ),
        ),
        SliverToBoxAdapter(
          child: _album?.intro != null && _album!.intro.isNotEmpty
              ? Padding(
                  padding: const EdgeInsets.fromLTRB(24, 10, 24, 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '专辑介绍',
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        _album!.intro,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                          height: 1.5,
                          fontWeight: FontWeight.w500,
                          fontSize: 12,
                        ),
                      ),
                      InkWell(
                          onTap: () {
                            CustomDialog.show(
                              context,
                              title: '专辑介绍',
                              content: _album!.intro,
                              confirmText: '确定',
                              showCancel: false,
                              width: 600,
                            );
                          },
                          hoverColor: Colors.transparent,
                          splashColor: Colors.transparent,
                          highlightColor: Colors.transparent,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(vertical: 2),
                            child: Text(
                              '查看详情',
                              style: TextStyle(
                                color: theme.colorScheme.primary,
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                )
              : const SizedBox.shrink(),
        ),
      ],
    );
  }

  Widget _buildTag(BuildContext context, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withAlpha(20),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(
          color: theme.colorScheme.primary.withAlpha(50),
          width: 0.5,
        ),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          color: theme.colorScheme.primary,
        ),
      ),
    );
  }

  String _formatNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}w';
  }

  Widget _buildInfoSmall(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          icon,
          size: 12,
          color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
          ),
        ),
      ],
    );
  }

  int _asInt(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  List<_AlbumAuthor> _parseAuthors(Map<String, dynamic> json) {
    final rawAuthors = json['authors'];
    if (rawAuthors is! List) return const <_AlbumAuthor>[];
    final authors = <_AlbumAuthor>[];
    for (final raw in rawAuthors) {
      if (raw is! Map) continue;
      final data = Map<String, dynamic>.from(raw);
      final name = (data['author_name'] ?? '').toString();
      if (name.isEmpty) continue;
      final id = _asInt(data['author_id']);
      authors.add(_AlbumAuthor(id: id, name: name));
    }
    return authors;
  }

  String? _firstNonEmptyString(List<dynamic> values) {
    for (final value in values) {
      final text = value?.toString();
      if (text != null && text.isNotEmpty && text != '0' && text != 'null') {
        return text;
      }
    }
    return null;
  }
}

class _AlbumAuthor {
  final int id;
  final String name;

  const _AlbumAuthor({required this.id, required this.name});
}
