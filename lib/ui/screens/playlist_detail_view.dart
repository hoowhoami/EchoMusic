import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/custom_toast.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/comment_floor_sheet.dart';
import '../widgets/resource_comment_slivers.dart';

class PlaylistDetailRouteArgs {
  const PlaylistDetailRouteArgs({required this.playlist});

  final Playlist playlist;

  int get playlistId => playlist.id;

  String get lookupId => playlist.globalCollectionId ?? playlist.id.toString();

  int? get trackListId => playlist.listid;

  String? get trackListCreateGid => playlist.listCreateGid;

  int? get trackListCreateUserid => playlist.listCreateUserid;

  factory PlaylistDetailRouteArgs.fromPlaylist(Playlist playlist) {
    return PlaylistDetailRouteArgs(playlist: playlist);
  }
}

class PlaylistDetailView extends StatefulWidget {
  final PlaylistDetailRouteArgs routeArgs;

  const PlaylistDetailView({super.key, required this.routeArgs});

  @override
  State<PlaylistDetailView> createState() => _PlaylistDetailViewState();
}

class _PlaylistDetailViewState extends State<PlaylistDetailView>
    with RefreshableState {
  static const int _pageSize = 200;

  @override
  String get refreshKey => 'playlist:${_routeArgs.lookupId}';

  late final PlaylistDetailRouteArgs _routeArgs;

  List<Song>? _songs;
  Playlist? _detailedPlaylist;
  bool _isLoading = true;
  late UserProvider _userProvider;
  int _currentPage = 1;
  int _loadedSongEntryCount = 0;
  int _filteredInvalidSongCount = 0;
  bool _hasMore = true;
  bool _isLoadingMore = false;
  bool _isResolvingAllSongs = false;
  bool _hasScheduledWarmUp = false;
  List<Song>? _allSongsCache;
  Future<List<Song>>? _resolveAllSongsFuture;
  AudioProvider? _playbackAppendProvider;
  int? _playbackAppendSessionId;

  // 评论相关
  bool _isCommentsLoading = false;
  bool _isFetchingMoreComments = false;
  bool _hasMoreComments = true;
  int _currentCommentPage = 1;
  static const int _commentPageSize = 30;
  final List<dynamic> _allComments = [];
  List<dynamic> _hotComments = [];
  int _totalCommentCount = 0;
  bool _hasLoadedComments = false;

  int get _totalSongCount {
    final detailedCount = _detailedPlaylist?.count ?? 0;
    if (detailedCount > 0) return detailedCount;
    final playlistCount = _routeArgs.playlist.count;
    if (playlistCount > 0) return playlistCount;
    return 0;
  }

  String get _lookupId => _routeArgs.lookupId;

  String get _playlistCommentId {
    final playlist = _detailedPlaylist ?? _routeArgs.playlist;
    final globalCollectionId = playlist.globalCollectionId;
    if (globalCollectionId != null && globalCollectionId.isNotEmpty) {
      return globalCollectionId;
    }

    final listCreateGid = playlist.listCreateGid;
    if (listCreateGid != null && listCreateGid.isNotEmpty) {
      return listCreateGid;
    }

    final userId = playlist.listCreateUserid;
    final listId = playlist.listCreateListid;
    if (userId != null && userId != 0 && listId != null && listId != 0) {
      return 'collection_3_${userId}_${listId}_0';
    }

    return _lookupId;
  }

  bool _computeHasMore({required int loadedCount, required int lastPageCount}) {
    final totalSongCount = _totalSongCount;
    if (totalSongCount > 0) return loadedCount < totalSongCount;
    return lastPageCount >= _pageSize;
  }

  @override
  void initState() {
    super.initState();
    _routeArgs = widget.routeArgs;
    _userProvider = context.read<UserProvider>();
    _userProvider.playlistSongsChangeNotifier.addListener(
      _onPlaylistSongsChanged,
    );
    _loadData();
  }

  @override
  void onRefresh() {
    _loadData();
  }

  @override
  void dispose() {
    _userProvider.playlistSongsChangeNotifier.removeListener(
      _onPlaylistSongsChanged,
    );
    super.dispose();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _currentPage = 1;
      _loadedSongEntryCount = 0;
      _filteredInvalidSongCount = 0;
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
    });

    // Fetch detailed info to get creator and timestamps
    final detailJson = await MusicApi.getPlaylistDetail(
      _routeArgs.trackListCreateGid ?? _lookupId,
    );

    if (detailJson != null && mounted) {
      setState(() {
        _detailedPlaylist = Playlist.fromUserPlaylist(detailJson);
      });
    }

    final result = await _fetchSongsPage(1);
    final songs = result.songs;

    if (mounted) {
      setState(() {
        _songs = songs;
        _isLoading = false;
        _loadedSongEntryCount = result.sourceCount;
        _filteredInvalidSongCount = result.filteredCount;
        _hasMore = _computeHasMore(
          loadedCount: _loadedSongEntryCount,
          lastPageCount: result.sourceCount,
        );
        if (!_hasMore) {
          _allSongsCache = List.unmodifiable(songs);
        }
      });

      _scheduleBackgroundResolve();
    }
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

  Future<PlaylistSongsParseResult> _fetchSongsPage(int page) {
    return MusicApi.getPlaylistSongsWithMetadata(
      _lookupId,
      listid: _routeArgs.trackListId,
      listCreateGid: _routeArgs.trackListCreateGid,
      listCreateUserid: _routeArgs.trackListCreateUserid,
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
      final data = await MusicApi.getPlaylistComments(
        _playlistCommentId,
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

  Future<void> _openPlaylistFloorComments(Map<String, dynamic> rawComment) async {
    final comment = Map<String, dynamic>.from(rawComment);
    final specialId = _firstNonEmptyString([comment['special_child_id']]);
    final tid = _firstNonEmptyString([comment['id']]);
    final code = _firstNonEmptyString([comment['code']]);

    if (specialId == null || tid == null || code == null) {
      CustomToast.error(context, '歌单楼层评论暂不可用');
      return;
    }

    await showCommentFloorSheet(
      context,
      comment: comment,
      unavailableMessage: '歌单楼层评论暂不可用',
      onFetch: ({required page, required pagesize}) {
        return MusicApi.getFloorComments(
          specialId,
          tid,
          code: code,
          resourceType: 'playlist',
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
    var loadedCount = _loadedSongEntryCount;
    var filteredCount = _filteredInvalidSongCount;
    var hasMore = _hasMore;

    try {
      while (hasMore) {
        final result = await _fetchSongsPage(nextPage);
        final pageEntryCount = result.sourceCount;
        if (pageEntryCount == 0) {
          hasMore = false;
          break;
        }

        songs.addAll(result.songs);
        lastLoadedPage = nextPage;
        loadedCount += pageEntryCount;
        filteredCount += result.filteredCount;
        hasMore = _computeHasMore(
          loadedCount: loadedCount,
          lastPageCount: pageEntryCount,
        );

        final playbackProvider = _playbackAppendProvider;
        final playbackSessionId = _playbackAppendSessionId;
        if (playbackProvider != null && playbackSessionId != null) {
          if (playbackProvider.playlistSessionId == playbackSessionId) {
            if (result.filteredCount > 0) {
              playbackProvider.addFilteredInvalidSongsToActivePlaylist(
                result.filteredCount,
                sessionId: playbackSessionId,
              );
            }
            if (result.songs.isNotEmpty &&
                !playbackProvider.appendSongsToActivePlaylist(
                  result.songs,
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
            _loadedSongEntryCount = loadedCount;
            _filteredInvalidSongCount = filteredCount;
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
          _loadedSongEntryCount = loadedCount;
          _filteredInvalidSongCount = filteredCount;
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

  void _playPlaylist() {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前列表暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithPlaylistSongs(songs[firstPlayableIndex]));
  }

  Future<void> _replacePlaybackWithPlaylistSongs(Song song) async {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前列表暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
    final sessionId = audioProvider.playlistSessionId;
    if (_filteredInvalidSongCount > 0) {
      audioProvider.addFilteredInvalidSongsToActivePlaylist(
        _filteredInvalidSongCount,
        sessionId: sessionId,
      );
    }
    _attachPlaybackPrefetch(audioProvider, sessionId);
    unawaited(_ensureAllSongsLoaded());
  }

  void _onPlaylistSongsChanged() {
    if (!mounted) return;
    final changedListId = _userProvider.playlistSongsChangeNotifier.value;
    if (changedListId == _routeArgs.playlistId ||
        changedListId == _routeArgs.trackListId) {
      _loadData();
    }
  }

  String _formatTimestamp(int? timestamp) {
    if (timestamp == null || timestamp == 0) return '未知';
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp * 1000);
    return DateFormat('yyyy-MM-dd').format(date);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final replacePlaylistEnabled = context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );
    final playlist = _detailedPlaylist ?? _routeArgs.playlist;
    final isFavorited = userProvider.isPlaylistFavorited(
      playlist.id,
      globalId: playlist.listCreateGid,
    );
    final isCreated = userProvider.isCreatedPlaylist(playlist.id);
    final songs = _songs ?? const <Song>[];
    final batchPreparing = _isResolvingAllSongs && _hasMore;

    final secondaryActions = <DetailPageSecondaryAction>[
      if (userProvider.isAuthenticated && !isCreated)
        DetailPageSecondaryAction(
          icon: isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
          label: '收藏',
          emphasized: isFavorited,
          onTap: () async {
            bool success;
            if (isFavorited) {
              success = await userProvider.unfavoritePlaylist(
                playlist.id,
                globalId: playlist.listCreateGid,
              );
              if (context.mounted) {
                if (success) {
                  CustomToast.success(context, '已取消收藏');
                } else {
                  CustomToast.error(context, '操作失败');
                }
              }
            } else {
              success = await userProvider.favoritePlaylist(
                playlist.originalId,
                playlist.name,
                listCreateUserid: playlist.listCreateUserid,
                listCreateGid: playlist.listCreateGid,
                listCreateListid: playlist.listCreateListid,
              );
              if (context.mounted) {
                if (success) {
                  CustomToast.success(context, '已收藏歌单');
                } else {
                  CustomToast.error(context, '收藏失败');
                }
              }
            }
          },
        ),
    ];

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      parentPlaylist: playlist,
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
              onTapReplies: _openPlaylistFloorComments,
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
          ? _replacePlaybackWithPlaylistSongs
          : null,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'PLAYLIST',
          title: playlist.name,
          expandedHeight: 200,
          expandedCover: CoverImage(
            url: playlist.pic,
            width: 136,
            height: 136,
            borderRadius: 18,
          ),
          collapsedCover: CoverImage(
            url: playlist.pic,
            width: 32,
            height: 32,
            borderRadius: 6,
            showShadow: false,
          ),
          detailChildren: [
            if (playlist.nickname.isNotEmpty)
              Wrap(
                spacing: 10,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (playlist.userPic.isNotEmpty)
                    ClipOval(
                      child: CoverImage(
                        url: playlist.userPic,
                        width: 20,
                        height: 20,
                        borderRadius: 0,
                        showShadow: false,
                      ),
                    )
                  else
                    Icon(
                      CupertinoIcons.person_circle_fill,
                      size: 20,
                      color: theme.colorScheme.primary.withAlpha(180),
                    ),
                  Text(
                    playlist.nickname,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.primary,
                      fontWeight: FontWeight.w800,
                      fontSize: 13,
                    ),
                  ),
                  Text(
                    '${_formatTimestamp(playlist.createTime)} 创建',
                    style: TextStyle(
                      color: theme.colorScheme.onSurface.withAlpha(100),
                      fontSize: 11,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _buildInfoSmall(
                  context,
                  CupertinoIcons.music_note_2,
                  '${playlist.count}',
                ),
                for (final tag in _parseTags(playlist.tags))
                  _buildTag(context, tag),
              ],
            ),
          ],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: _playPlaylist,
            songs: songs,
            sourceId: playlist.id,
            onResolveSongs: _loadAllSongsForBatch,
            isBatchPreparing: batchPreparing,
            secondaryActions: secondaryActions,
          ),
        ),
        if (playlist.intro.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 10, 24, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '歌单介绍',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    playlist.intro,
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
                          title: '歌单介绍',
                          content: playlist.intro,
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
            ),
          ),
      ],
    );
  }

  List<String> _parseTags(String rawTags) {
    return rawTags
        .split(',')
        .map((tag) => tag.trim())
        .where((tag) => tag.isNotEmpty)
        .toList(growable: false);
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
