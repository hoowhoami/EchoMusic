import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/artist.dart';
import '../../models/album.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import '../../providers/navigation_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/album_card.dart';
import 'package:echomusic/theme/app_theme.dart';

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
  static const int _albumPageSize = 30;

  @override
  String get refreshKey => 'artist_detail:${widget.artistId}';

  Artist? _artist;
  List<Song>? _songs;
  List<Album>? _albums;
  bool _isLoading = true;
  int _currentPage = 1;
  bool _hasMore = true;
  bool _isLoadingMore = false;
  bool _isAlbumLoading = true;
  bool _isAlbumLoadingMore = false;
  bool _hasMoreAlbums = true;
  int _albumPage = 1;
  bool _hasLoadedAlbums = false;
  bool _isResolvingAllSongs = false;
  bool _hasScheduledWarmUp = false;
  List<Song>? _allSongsCache;
  Future<List<Song>>? _resolveAllSongsFuture;
  AudioProvider? _playbackAppendProvider;
  int? _playbackAppendSessionId;

  int get _totalSongCount => _artist?.songCount ?? 0;
  int get _totalAlbumCount => _artist?.albumCount ?? 0;

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
      _albums = null;
      _isAlbumLoading = true;
      _isAlbumLoadingMore = false;
      _hasMoreAlbums = true;
      _albumPage = 1;
      _hasLoadedAlbums = false;
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
        _albums = const <Album>[];
        _isAlbumLoading = false;
        _hasMoreAlbums = false;
      });

      _scheduleBackgroundResolve();
    }
  }

  void _onPrimaryTabChanged(SongListPrimaryTab tab) {
    if (tab != SongListPrimaryTab.comments || _hasLoadedAlbums) return;
    _hasLoadedAlbums = true;
    if (mounted) {
      setState(() => _isAlbumLoading = true);
    }
    unawaited(_fetchAlbumsPage(1).then((albums) {
      if (!mounted) return;
      final albumLoadedCount = albums.length;
      setState(() {
        _albums = albums;
        _isAlbumLoading = false;
        _albumPage = 1;
        _hasMoreAlbums = _computeHasMoreAlbums(
          loadedCount: albumLoadedCount,
          lastPageCount: albumLoadedCount,
        );
      });
    }));
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

  Future<List<Album>> _fetchAlbumsPage(int page) {
    return MusicApi.getSingerAlbums(
      widget.artistId,
      page: page,
      pagesize: _albumPageSize,
      sort: 'hot',
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

  bool _computeHasMoreAlbums({required int loadedCount, required int lastPageCount}) {
    final totalAlbumCount = _totalAlbumCount;
    if (totalAlbumCount > 0) return loadedCount < totalAlbumCount;
    return lastPageCount >= _albumPageSize;
  }

  Future<void> _loadMoreAlbums() async {
    if (_isAlbumLoadingMore || !_hasMoreAlbums || !mounted) return;
    setState(() => _isAlbumLoadingMore = true);

    try {
      final nextPage = _albumPage + 1;
      final moreAlbums = await _fetchAlbumsPage(nextPage);
      if (!mounted) return;

      final updatedAlbums = [...?_albums, ...moreAlbums];
      final hasMore = _computeHasMoreAlbums(
        loadedCount: updatedAlbums.length,
        lastPageCount: moreAlbums.length,
      );

      setState(() {
        _albums = updatedAlbums;
        _albumPage = nextPage;
        _hasMoreAlbums = hasMore;
        _isAlbumLoadingMore = false;
      });
    } catch (_) {
      if (mounted) setState(() => _isAlbumLoadingMore = false);
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
      commentSlivers: _hasLoadedAlbums ? _buildAlbumSlivers(context) : null,
      commentsTabTitle: '专辑',
      hasMoreComments: _hasMoreAlbums,
      isLoadingMoreComments: _isAlbumLoadingMore,
      onCommentsLoadMore: _loadMoreAlbums,
      commentsTabBadgeLabel:
          _artist?.albumCount != null && _artist!.albumCount > 0
              ? '${_artist!.albumCount}'
              : null,
      onPrimaryTabChanged: _onPrimaryTabChanged,
      initialPrimaryTab: SongListPrimaryTab.songs,
      hasCommentsTab: true,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'ARTIST',
          title: widget.artistName,
          expandedHeight: 200,
          expandedCover: _artist != null
              ? Container(
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
                    child: CoverImage(
                      url: _artist!.pic,
                      width: 136,
                      height: 136,
                      borderRadius: 0,
                      showShadow: false,
                    ),
                  ),
                )
              : Container(
                  width: 136,
                  height: 136,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    CupertinoIcons.person_fill,
                    size: 54,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
          collapsedCover: _artist != null
              ? CoverImage(
                  url: _artist!.pic,
                  width: 32,
                  height: 32,
                  borderRadius: 16,
                  showShadow: false,
                )
              : Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surfaceContainerHighest,
                    shape: BoxShape.circle,
                  ),
                  child: Icon(
                    CupertinoIcons.person_fill,
                    size: 16,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
          detailChildren: [
            if (_artist != null)
              Text(
                '${_artist!.songCount} 首歌曲 • ${_artist!.albumCount} 张专辑 • ${_formatCount(_artist!.fansCount)} 粉丝',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant,
                  fontSize: 14,
                  fontWeight: AppTheme.fontWeightSemiBold,
                ),
              ),
          ],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: _playArtistSongs,
            songs: songs,
            sourceId: widget.artistId,
            onResolveSongs: _loadAllSongsForBatch,
            isBatchPreparing: batchPreparing,
            secondaryAction: secondaryAction,
          ),
        ),
        if (_artist != null && _artist!.intro.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 10, 24, 6),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '歌手简介',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: AppTheme.fontWeightSemiBold,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _artist!.intro,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                      height: 1.5,
                      fontWeight: AppTheme.fontWeightRegular,
                      fontSize: 12,
                    ),
                  ),
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
                            fontWeight: AppTheme.fontWeightSemiBold,
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

  List<Widget> _buildAlbumSlivers(BuildContext context) {
    final theme = Theme.of(context);
    final albums = _albums ?? const <Album>[];

    if (_isAlbumLoading) {
      return const [
        SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.only(top: 60),
            child: Center(child: CupertinoActivityIndicator()),
          ),
        ),
      ];
    }

    if (albums.isEmpty) {
      return [
        SliverToBoxAdapter(
          child: Center(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 32, 24, 40),
              child: Text(
                '暂无专辑',
                style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
              ),
            ),
          ),
        ),
      ];
    }

    return [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(24, 6, 24, 24),
        sliver: SliverGrid(
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 220,
            mainAxisExtent: 230,
            mainAxisSpacing: 20,
            crossAxisSpacing: 20,
          ),
          delegate: SliverChildBuilderDelegate(
            (context, index) {
              final album = albums[index];
              final subtitleParts = <String>[];
              if (album.publishTime.isNotEmpty) {
                subtitleParts.add(album.publishTime);
              }
              if (album.songCount > 0) {
                subtitleParts.add('${album.songCount} 首歌曲');
              }
              final subtitle =
                  subtitleParts.isEmpty ? null : subtitleParts.join(' • ');
              return AlbumCard.grid(
                album: album,
                subtitle: subtitle,
                onTap: () => context
                    .read<NavigationProvider>()
                    .openAlbum(album.id, album.name),
              );
            },
            childCount: albums.length,
          ),
        ),
      ),
    ];
  }

  String _formatCount(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}w';
  }
}
