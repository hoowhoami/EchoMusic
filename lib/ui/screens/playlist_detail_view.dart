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
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';

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

  late final PlaylistDetailRouteArgs _routeArgs;

  @override
  String get refreshKey => 'playlist:${_routeArgs.lookupId}';

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

  int get _totalSongCount {
    final detailedCount = _detailedPlaylist?.count ?? 0;
    if (detailedCount > 0) return detailedCount;
    final playlistCount = _routeArgs.playlist.count;
    if (playlistCount > 0) return playlistCount;
    return 0;
  }

  String get _lookupId => _routeArgs.lookupId;

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
    final secondaryAction = userProvider.isAuthenticated && !isCreated
        ? DetailPageSecondaryAction(
            icon: isFavorited
                ? CupertinoIcons.heart_fill
                : CupertinoIcons.heart,
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
          )
        : null;

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      parentPlaylist: playlist,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore || batchPreparing,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? _replacePlaybackWithPlaylistSongs
          : null,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 168,
          pinned: true,
          elevation: 0,
          automaticallyImplyLeading: false,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: EdgeInsets.zero,
            centerTitle: false,
            expandedTitleScale: 1.0,
            title: LayoutBuilder(
              builder: (context, constraints) {
                final double settings = constraints.maxHeight;
                final bool isCollapsed = settings <= kToolbarHeight + 20;

                return AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: isCollapsed ? 1.0 : 0.0,
                  child: Container(
                    height: kToolbarHeight,
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
                    child: Row(
                      children: [
                        CoverImage(
                          url: playlist.pic,
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          showShadow: false,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            playlist.name,
                            style: TextStyle(
                              color: theme.colorScheme.onSurface,
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        const SizedBox(width: 12),
                        DetailPageActionRow(
                          playLabel: '播放',
                          onPlay: _playPlaylist,
                          songs: songs,
                          sourceId: playlist.id,
                          onResolveSongs: _loadAllSongsForBatch,
                          isBatchPreparing: batchPreparing,
                          secondaryAction: secondaryAction,
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
            background: Padding(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  CoverImage(
                    url: playlist.pic,
                    width: 130,
                    height: 130,
                    borderRadius: 16,
                  ),
                  const SizedBox(width: 24),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          'PLAYLIST',
                          style: TextStyle(
                            color: theme.colorScheme.primary,
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 2.0,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          playlist.name,
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (playlist.nickname.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Row(
                              children: [
                                if (playlist.userPic.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: ClipOval(
                                      child: CoverImage(
                                        url: playlist.userPic,
                                        width: 20,
                                        height: 20,
                                        borderRadius: 0,
                                        showShadow: false,
                                      ),
                                    ),
                                  )
                                else
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: Icon(
                                      CupertinoIcons.person_circle_fill,
                                      size: 20,
                                      color: theme.colorScheme.primary
                                          .withAlpha(180),
                                    ),
                                  ),
                                Text(
                                  playlist.nickname,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.primary,
                                    fontWeight: FontWeight.w800,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  '${_formatTimestamp(playlist.createTime)} 创建',
                                  style: TextStyle(
                                    color: theme.colorScheme.onSurface
                                        .withAlpha(100),
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        if (playlist.intro.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  playlist.intro,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                    fontWeight: FontWeight.w500,
                                    fontSize: 12,
                                    height: 1.4,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        Row(
                          children: [
                            _buildInfoChip(
                              context,
                              CupertinoIcons.music_note_2,
                              '${playlist.count} 首歌曲',
                            ),
                            const Spacer(),
                            DetailPageActionRow(
                              playLabel: '播放',
                              onPlay: _playPlaylist,
                              songs: songs,
                              sourceId: playlist.id,
                              onResolveSongs: _loadAllSongsForBatch,
                              isBatchPreparing: batchPreparing,
                              secondaryAction: secondaryAction,
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildInfoChip(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
