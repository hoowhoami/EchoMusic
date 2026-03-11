import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/artist.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';

class ArtistDetailView extends StatefulWidget {
  final int artistId;
  final String artistName;
  const ArtistDetailView({
    super.key,
    required this.artistId,
    required this.artistName,
  });

  @override
  State<ArtistDetailView> createState() => _ArtistDetailViewState();
}

class _ArtistDetailViewState extends State<ArtistDetailView>
    with RefreshableState {
  static const int _pageSize = 200;

  @override
  String get refreshKey => 'artist_detail:${widget.artistId}';

  Artist? _artist;
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

  int get _totalSongCount => _artist?.songCount ?? 0;

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
    });

    final results = await Future.wait([
      MusicApi.getSingerDetail(widget.artistId),
      _fetchSongsPage(1),
    ]);

    if (mounted) {
      setState(() {
        final artistJson = results[0] as Map<String, dynamic>?;
        if (artistJson != null) {
          _artist = Artist.fromDetailJson(artistJson);
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

  void _scheduleBackgroundResolve() {
    if (_hasScheduledWarmUp || !_hasMore || !mounted) return;
    _hasScheduledWarmUp = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_hasMore) return;
      unawaited(_ensureAllSongsLoaded());
    });
  }

  Future<List<Song>> _fetchSongsPage(int page) {
    return MusicApi.getSingerSongs(
      widget.artistId,
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

  void _playArtistSongs() {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前列表暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithArtistSongs(songs[firstPlayableIndex]));
  }

  Future<void> _replacePlaybackWithArtistSongs(Song song) async {
    final songs = _songs ?? [];
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前列表暂无可播放歌曲');
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
    final isFollowing = userProvider.isFollowingSinger(widget.artistId);
    final theme = Theme.of(context);
    final replacePlaylistEnabled = context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );
    final songs = _songs ?? const <Song>[];
    final batchPreparing = _isResolvingAllSongs && _hasMore;
    final secondaryAction = DetailPageSecondaryAction(
      icon: isFollowing ? CupertinoIcons.checkmark : CupertinoIcons.add,
      label: isFollowing ? '已关注' : '关注',
      emphasized: isFollowing,
      onTap: () async {
        bool success;
        if (isFollowing) {
          success = await userProvider.unfollowSinger(widget.artistId);
          if (!context.mounted) return;
          if (success) {
            CustomToast.success(context, '已取消关注');
          } else {
            CustomToast.error(context, '操作失败');
          }
        } else {
          success = await userProvider.followSinger(widget.artistId);
          if (!context.mounted) return;
          if (success) {
            CustomToast.success(context, '关注成功');
          } else {
            CustomToast.error(context, '关注失败');
          }
        }
      },
    );

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore || batchPreparing,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? _replacePlaybackWithArtistSongs
          : null,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 168,
          pinned: true,
          automaticallyImplyLeading: false,
          elevation: 0,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: EdgeInsets.zero,
            centerTitle: false,
            expandedTitleScale: 1.0,
            title: LayoutBuilder(
              builder: (context, constraints) {
                final bool isCollapsed =
                    constraints.maxHeight <= kToolbarHeight + 20;
                return AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: isCollapsed ? 1.0 : 0.0,
                  child: Container(
                    height: kToolbarHeight,
                    padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
                    child: Row(
                      children: [
                        if (_artist != null)
                          CoverImage(
                            url: _artist!.pic,
                            width: 32,
                            height: 32,
                            borderRadius: 16,
                            showShadow: false,
                          ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            widget.artistName,
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
                          onPlay: _playArtistSongs,
                          songs: songs,
                          sourceId: widget.artistId,
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
            background: Container(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (_artist != null)
                    Container(
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(
                            color: theme.colorScheme.shadow.withAlpha(50),
                            blurRadius: 20,
                            offset: const Offset(0, 10),
                          ),
                        ],
                      ),
                      child: ClipOval(
                        child: CachedNetworkImage(
                          imageUrl: _artist!.pic,
                          width: 130,
                          height: 130,
                          fit: BoxFit.cover,
                        ),
                      ),
                    )
                  else
                    Container(
                      width: 130,
                      height: 130,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.surfaceContainerHighest,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        CupertinoIcons.person_fill,
                        size: 52,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  const SizedBox(width: 32),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          'ARTIST',
                          style: TextStyle(
                            color: theme.colorScheme.primary,
                            fontSize: 11,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 2.0,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          widget.artistName,
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (_artist != null)
                          Row(
                            children: [
                              Text(
                                '${_artist!.songCount} 首歌曲 • ${_artist!.albumCount} 张专辑 • ${_artist!.fansCount} 粉丝',
                                style: TextStyle(
                                  color: theme.colorScheme.onSurfaceVariant,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const Spacer(),
                              DetailPageActionRow(
                                playLabel: '播放',
                                onPlay: _playArtistSongs,
                                songs: songs,
                                sourceId: widget.artistId,
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
        if (_artist != null && _artist!.intro.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 6, 24, 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '歌手简介',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _artist!.intro,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                      height: 1.5,
                      fontWeight: FontWeight.w500,
                      fontSize: 12,
                    ),
                  ),
                  if (_artist!.intro.length > 80)
                    InkWell(
                      onTap: () {
                        CustomDialog.show(
                          context,
                          title: '歌手简介',
                          content: _artist!.intro,
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
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 4),
            child: Text(
              '热门歌曲',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
                fontSize: 15,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
