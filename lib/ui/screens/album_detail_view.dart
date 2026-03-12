import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/album.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/custom_toast.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_action_row.dart';
import '../../models/playlist.dart' as model;

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

  int get _totalSongCount => _album?.songCount ?? 0;

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
      MusicApi.getAlbumDetail(widget.albumId),
      _fetchSongsPage(1),
    ]);

    if (mounted) {
      setState(() {
        final albumJson = results[0] as Map<String, dynamic>?;
        if (albumJson != null) {
          _album = Album.fromDetailJson(albumJson);
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
    return MusicApi.getAlbumSongs(
      widget.albumId,
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
    final secondaryAction = DetailPageSecondaryAction(
      icon: isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
      label: '收藏',
      emphasized: isFavorited,
      onTap: () async {
        if (!userProvider.isAuthenticated) {
          CustomToast.error(context, '请先登录');
          return;
        }

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
    );

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore || batchPreparing,
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
            if (_album != null)
              Text(
                '${_album!.singerName} • ${_album!.publishTime}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
            if (_album != null)
              Wrap(
                spacing: 12,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
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
            secondaryAction: secondaryAction,
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
}
